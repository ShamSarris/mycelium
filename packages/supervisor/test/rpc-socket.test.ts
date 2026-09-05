import { stat } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UnixSocketBroker, listenAddress } from '../src/rpc/broker.js';
import { buildTestApp, type TestHarness } from './helpers/app.js';

let h: TestHarness;
let broker: UnixSocketBroker;
let socketPath: string;

const PLAN_ID = '018f3a5c-0000-7000-8000-00000000000a';
const onPosix = process.platform !== 'win32';

beforeAll(async () => {
  h = await buildTestApp();
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  h.reset();
  h.provisionEnvironment(PLAN_ID);
  broker = new UnixSocketBroker(h.deps);
  socketPath = path.join(h.stateDir, `broker-${Date.now()}-${Math.random()}.sock`);
  await broker.listen(PLAN_ID, socketPath);
});

afterEach(async () => {
  await broker.closeAll();
});

/** One request, one response, close — the whole protocol. */
function request(payload: unknown, address = listenAddress(socketPath)): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(address, () => {
      socket.end(`${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n`);
    });
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    socket.on('error', reject);
  });
}

describe('the broker socket', () => {
  it('answers a well-formed call', async () => {
    const response = await request({
      method: 'events.emit',
      params: { type: 'agent.tool_call', payload: { tool: 'bash' } },
    });

    expect(response).toEqual({ ok: true, result: { recorded: true } });
    expect(h.events.ofType('agent.tool_call')).toHaveLength(1);
  });

  it('runs a sandbox through the same socket', async () => {
    const response = await request({
      method: 'sandbox.run',
      params: { image: 'node:22-alpine', cmd: ['node', '-v'] },
    });

    expect(response).toMatchObject({ ok: true });
    expect(h.containers.runs).toHaveLength(1);
  });

  it('serves several calls in sequence', async () => {
    await request({ method: 'events.emit', params: { type: 'agent.tool_call' } });
    await request({ method: 'events.emit', params: { type: 'agent.model_call' } });

    expect(h.events.events).toHaveLength(2);
  });

  // The caller is semi-trusted and assumed prompt-injectable, so a malformed
  // request has to be an answer rather than an exception that ends the listener.
  it('answers rubbish without dying', async () => {
    const response = await request('not json at all');
    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_request' } });

    const after = await request({ method: 'events.emit', params: { type: 'agent.tool_call' } });
    expect(after).toMatchObject({ ok: true });
  });

  it('answers an unknown method without dying', async () => {
    const response = await request({ method: 'docker.socket.please' });
    expect(response).toMatchObject({ ok: false, error: { code: 'unknown_method' } });
  });

  it('stamps the plan from the socket, so the agent cannot name another', async () => {
    await request({
      method: 'events.emit',
      params: { type: 'agent.tool_call', plan_id: 'a-different-plan' },
    });

    expect(h.events.events[0]?.planId).toBe(PLAN_ID);
  });

  it('stops answering once closed', async () => {
    await broker.close(PLAN_ID);
    await expect(request({ method: 'events.emit', params: { type: 'agent.tool_call' } })).rejects.toThrow();
  });

  it('can be re-listened on the same path after a close', async () => {
    await broker.close(PLAN_ID);
    await broker.listen(PLAN_ID, socketPath);

    const response = await request({ method: 'events.emit', params: { type: 'agent.tool_call' } });
    expect(response).toMatchObject({ ok: true });
  });
});

describe('the socket file', () => {
  it.skipIf(!onPosix)('is owner-only, which is the whole authorisation (B20)', async () => {
    const mode = (await stat(socketPath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it.skipIf(onPosix)('falls back to a named pipe on Windows, where AF_UNIX paths do not bind', () => {
    expect(listenAddress(socketPath)).toMatch(/^\\\\\.\\pipe\\mycelium-/);
  });

  it('uses the path itself everywhere the daemon actually runs', () => {
    if (onPosix) expect(listenAddress(socketPath)).toBe(socketPath);
  });
});
