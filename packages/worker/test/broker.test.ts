import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrokerRejection, SocketBrokerClient } from '../src/broker.js';
import { buildTestWorker, type TestWorker } from './helpers/agent.js';
import { startStubBroker, type StubBroker } from './helpers/stub-broker.js';

/**
 * The agent's only channel to the supervisor. Two rules the tests exist to
 * hold: emitting an event may never take this process down — the supervisor
 * owns the durable spool and an agent that buffered would be the agent-side
 * buffering archive T3 forbids — and the agent never numbers its own events.
 */

let h: TestWorker;
let stub: StubBroker;
let client: SocketBrokerClient;

beforeEach(async () => {
  h = await buildTestWorker();
  stub = await startStubBroker(h.config.brokerSocket);
  client = new SocketBrokerClient(h.config.brokerSocket, h.config.brokerTimeoutMs);
});

afterEach(async () => {
  await stub.close();
  await h.close();
});

describe('emit', () => {
  it('sends one request on its own connection and closes', async () => {
    await client.emit({ type: 'agent.tool_call', payload: { tool: 'sandbox' } });
    await client.emit({ type: 'agent.model_call', payload: { turn: 1 } });

    expect(stub.connections).toBe(2);
    expect(stub.requests).toHaveLength(2);
    expect((stub.requests[0] as { method: string }).method).toBe('events.emit');
  });

  it('sends only what the agent is allowed to say about an event', async () => {
    await client.emit({
      type: 'agent.tool_call',
      severity: 'warn',
      taskId: 'task-1',
      payload: { tool: 'git' },
    });

    const params = (stub.requests[0] as { params: Record<string, unknown> }).params;
    expect(params).toEqual({
      type: 'agent.tool_call',
      severity: 'warn',
      task_id: 'task-1',
      payload: { tool: 'git' },
    });
  });

  it('never numbers its own events', async () => {
    await client.emit({ type: 'error', payload: { stage: 'loop' } });

    const params = (stub.requests[0] as { params: Record<string, unknown> }).params;
    // The supervisor stamps these from the socket the request arrived on. An
    // agent that guessed would be reporting an emitter bug it had caused.
    expect(params).not.toHaveProperty('seq');
    expect(params).not.toHaveProperty('stream_id');
    expect(params).not.toHaveProperty('event_id');
    expect(params).not.toHaveProperty('plan_id');
    expect(params).not.toHaveProperty('source');
  });

  it('defaults severity and task id rather than omitting the fields', async () => {
    await client.emit({ type: 'agent.model_call' });

    const params = (stub.requests[0] as { params: Record<string, unknown> }).params;
    expect(params.severity).toBe('info');
    expect(params.task_id).toBeNull();
  });

  it('drops an emit the supervisor refused, and does not throw', async () => {
    stub.respond = () => ({ ok: false, error: { code: 'invalid_event', message: 'no such type' } });

    await expect(client.emit({ type: 'error' })).resolves.toBeUndefined();
  });

  it('drops an emit when the broker is gone entirely, and does not throw', async () => {
    await stub.close();

    await expect(client.emit({ type: 'error' })).resolves.toBeUndefined();
  });

  it('gives up on a broker that accepts and never answers', async () => {
    stub.silent = true;
    client = new SocketBrokerClient(h.config.brokerSocket, 50);

    await expect(client.emit({ type: 'error' })).resolves.toBeUndefined();
  });
});

function validResult(overrides: Record<string, unknown> = {}) {
  return {
    container_id: 'c-9',
    exit_code: 0,
    timed_out: false,
    stdout: { preview: '', bytes: 0, truncated: false },
    stderr: { preview: '', bytes: 0, truncated: false },
    ...overrides,
  };
}

describe('sandboxRun', () => {
  it('returns what the broker returned', async () => {
    stub.respond = () => ({
      ok: true,
      result: validResult({ stdout: { preview: 'ok', bytes: 2, truncated: false } }),
    });

    const result = await client.sandboxRun({ image: 'node:22', cmd: ['node', '-e', '1'] });

    expect(result.container_id).toBe('c-9');
    expect(result.stdout.preview).toBe('ok');
  });

  it('passes the parameters through untouched', async () => {
    stub.respond = () => ({ ok: true, result: validResult() });

    await client.sandboxRun({
      image: 'node:22',
      cmd: ['npm', 'test'],
      network: true,
      limits: { timeout_sec: 60 },
    });

    expect((stub.requests[0] as { params: unknown }).params).toEqual({
      image: 'node:22',
      cmd: ['npm', 'test'],
      network: true,
      limits: { timeout_sec: 60 },
    });
  });

  it('turns a structured refusal into a BrokerRejection carrying its code', async () => {
    stub.respond = () => ({
      ok: false,
      error: { code: 'image_not_allowed', message: 'evil:latest is not on the allowlist' },
    });

    await expect(
      client.sandboxRun({ image: 'evil:latest', cmd: ['sh'] }),
    ).rejects.toMatchObject({ name: 'BrokerRejection', code: 'image_not_allowed' });
  });

  it('turns an unreachable broker into a BrokerRejection too, not a raw socket error', async () => {
    await stub.close();

    // The tool layer turns either into a tool result the model can react to,
    // so they must arrive in the same shape.
    await expect(client.sandboxRun({ image: 'node:22', cmd: ['sh'] })).rejects.toBeInstanceOf(
      BrokerRejection,
    );
  });

  it('rejects a malformed answer rather than handing the model garbage', async () => {
    stub.respond = () => ({ nonsense: true });

    await expect(client.sandboxRun({ image: 'node:22', cmd: ['sh'] })).rejects.toBeInstanceOf(
      BrokerRejection,
    );
  });
});
