import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handleRpc } from '../src/rpc/handlers.js';
import { buildTestApp, type TestHarness } from './helpers/app.js';

let h: TestHarness;

const PLAN_ID = '018f3a5c-0000-7000-8000-00000000000a';

beforeAll(async () => {
  h = await buildTestApp();
});

afterAll(async () => {
  await h.close();
});

beforeEach(() => {
  h.reset();
  h.provisionEnvironment(PLAN_ID);
});

function call(method: string, params: unknown = {}) {
  return handleRpc(h.deps, PLAN_ID, { method, params });
}

describe('the RPC envelope', () => {
  it('refuses an unknown method', async () => {
    const response = await call('sandbox.escape');
    expect(response).toMatchObject({ ok: false, error: { code: 'unknown_method' } });
  });

  it('refuses a request that is not shaped like one', async () => {
    const response = await handleRpc(h.deps, PLAN_ID, 'hello' as never);
    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
  });

  it('refuses a call for a plan this node is no longer running', async () => {
    const response = await handleRpc(h.deps, 'plan-that-was-torn-down', {
      method: 'sandbox.run',
      params: { image: 'node:22-alpine', cmd: ['node', '-e', ''] },
    });
    expect(response).toMatchObject({ ok: false, error: { code: 'no_environment' } });
  });
});

describe('events.emit', () => {
  it('records an agent event on the plan it came from', async () => {
    const response = await call('events.emit', {
      type: 'agent.tool_call',
      payload: { tool: 'bash' },
    });

    expect(response).toEqual({ ok: true, result: { recorded: true } });
    const [event] = h.events.ofType('agent.tool_call');
    expect(event?.source).toBe('agent');
    expect(event?.planId).toBe(PLAN_ID);
  });

  // The agent cannot forge provenance: source and plan are stamped from the
  // socket it arrived on, not from what it asked for.
  it('ignores a source the agent supplies', async () => {
    await call('events.emit', { type: 'agent.tool_call', source: 'orchestrator' });
    expect(h.events.events[0]?.source).toBe('agent');
  });

  it('ignores a plan id the agent supplies', async () => {
    await call('events.emit', { type: 'agent.tool_call', plan_id: 'someone-elses-plan' });
    expect(h.events.events[0]?.planId).toBe(PLAN_ID);
  });

  it('keeps the emitter timestamp, which is what the event log shows', async () => {
    await call('events.emit', { type: 'agent.tool_call', ts: '2026-09-02T11:00:00.000Z' });
    expect(h.events.events[0]?.ts).toBe('2026-09-02T11:00:00.000Z');
  });

  it('carries the task id through, so an event joins its task', async () => {
    await call('events.emit', { type: 'agent.tool_call', task_id: 'task-1' });
    expect(h.events.events[0]?.taskId).toBe('task-1');
  });

  it('refuses an event type outside the contract', async () => {
    const response = await call('events.emit', { type: 'agent.telepathy' });
    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_event' } });
  });

  // Baseline section 7: no secret is ever written to an event payload. The
  // orchestrator rejects the whole batch for this, which would wedge the spool,
  // so it is caught at the point of entry instead.
  it('refuses a payload key that looks like a secret', async () => {
    const response = await call('events.emit', {
      type: 'agent.tool_call',
      payload: { api_key: 'sk-oops' },
    });
    expect(response).toMatchObject({ ok: false, error: { code: 'secret_in_payload' } });
    expect(h.events.events).toHaveLength(0);
  });
});

describe('sandbox.run - the allowlist', () => {
  it('runs an allowlisted image', async () => {
    const response = await call('sandbox.run', { image: 'node:22-alpine', cmd: ['node', '-v'] });

    expect(response).toMatchObject({ ok: true });
    expect(h.containers.runs).toHaveLength(1);
  });

  it('refuses an image that is not on the list', async () => {
    const response = await call('sandbox.run', { image: 'ubuntu:latest', cmd: ['sh'] });

    expect(response).toMatchObject({ ok: false, error: { code: 'image_not_allowed' } });
    expect(h.containers.runs).toHaveLength(0);
  });

  it('refuses a request with no command', async () => {
    const response = await call('sandbox.run', { image: 'node:22-alpine' });
    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_params' } });
  });
});

describe('sandbox.run - what the agent cannot override (G3, B6)', () => {
  it('mounts the plan checkout and nothing else', async () => {
    await call('sandbox.run', { image: 'node:22-alpine', cmd: ['node', '-v'] });

    const [spec] = h.containers.runs;
    expect(spec?.mounts).toHaveLength(1);
    expect(spec?.mounts[0]?.target).toBe(spec?.workdir);
    expect(spec?.mounts[0]?.source).toBe(h.ledger.get(PLAN_ID)?.workdir);
  });

  it('puts a networked sandbox on the plan network, never the default bridge', async () => {
    await call('sandbox.run', { image: 'node:22-alpine', cmd: ['node', '-v'], network: true });
    expect(h.containers.runs[0]?.network).toBe(`mycelium-${PLAN_ID}`);
  });

  it('gives a sandbox no network at all unless it asks', async () => {
    await call('sandbox.run', { image: 'node:22-alpine', cmd: ['node', '-v'] });
    expect(h.containers.runs[0]?.network).toBeNull();
  });

  it('points a networked sandbox at the proxy, its only path out', async () => {
    await call('sandbox.run', { image: 'node:22-alpine', cmd: ['node', '-v'], network: true });

    const env = h.containers.runs[0]?.env ?? {};
    expect(env.HTTPS_PROXY).toContain('10.99.0.1');
    expect(env.HTTP_PROXY).toBe(env.HTTPS_PROXY);
  });

  it('refuses a credential-shaped environment variable', async () => {
    const response = await call('sandbox.run', {
      image: 'node:22-alpine',
      cmd: ['node', '-v'],
      env: { GITEA_BOT_TOKEN: 'leak' },
    });

    expect(response).toMatchObject({ ok: false, error: { code: 'credential_in_sandbox_env' } });
    expect(h.containers.runs).toHaveLength(0);
  });

  it('refuses an attempt to override the proxy', async () => {
    const response = await call('sandbox.run', {
      image: 'node:22-alpine',
      cmd: ['node', '-v'],
      network: true,
      env: { HTTPS_PROXY: 'http://attacker.test:3128' },
    });
    expect(response).toMatchObject({ ok: false, error: { code: 'reserved_sandbox_env' } });
  });

  it('caps the wall clock at the configured ceiling', async () => {
    await call('sandbox.run', {
      image: 'node:22-alpine',
      cmd: ['node', '-v'],
      limits: { timeout_sec: 99_999 },
    });
    expect(h.containers.runs[0]?.timeoutSec).toBe(h.config.sandboxTimeoutCeilingSec);
  });

  it('uses the configured default when no timeout is asked for', async () => {
    await call('sandbox.run', { image: 'node:22-alpine', cmd: ['node', '-v'] });
    expect(h.containers.runs[0]?.timeoutSec).toBe(300);
  });

  it('caps cpu and memory at the configured values', async () => {
    await call('sandbox.run', {
      image: 'node:22-alpine',
      cmd: ['node', '-v'],
      limits: { cpus: 64, memory_mb: 999_999 },
    });

    expect(h.containers.runs[0]?.cpus).toBe(h.config.sandboxCpus);
    expect(h.containers.runs[0]?.memoryMb).toBe(h.config.sandboxMemoryMb);
  });
});

describe('sandbox.run - capacity and bookkeeping', () => {
  it('refuses past the per-environment cap rather than queueing', async () => {
    const environment = h.ledger.get(PLAN_ID);
    for (let i = 0; i < h.config.maxSandboxesPerEnvironment; i += 1) {
      environment?.sandboxes.add(`container-${i}`);
    }

    const response = await call('sandbox.run', { image: 'node:22-alpine', cmd: ['node', '-v'] });
    expect(response).toMatchObject({ ok: false, error: { code: 'capacity_exceeded' } });
  });

  it('forgets the container once it has exited', async () => {
    await call('sandbox.run', { image: 'node:22-alpine', cmd: ['node', '-v'] });
    expect(h.ledger.get(PLAN_ID)?.sandboxes.size).toBe(0);
  });

  it('tracks the container while it runs, so teardown can find it', async () => {
    h.containers.holdRuns();
    const pending = call('sandbox.run', { image: 'node:22-alpine', cmd: ['node', '-v'] });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.ledger.get(PLAN_ID)?.sandboxes.size).toBe(1);

    h.containers.releaseRuns();
    await pending;
  });

  it('records the launch and the exit', async () => {
    await call('sandbox.run', { image: 'node:22-alpine', cmd: ['node', '-v'] });

    expect(h.events.ofType('sandbox.launched')).toHaveLength(1);
    expect(h.events.ofType('sandbox.exited')).toHaveLength(1);
    expect(h.events.ofType('sandbox.launched')[0]?.payload).toMatchObject({
      image: 'node:22-alpine',
    });
  });
});

describe('sandbox.run - bounded output', () => {
  it('returns the exit status and previews', async () => {
    h.containers.nextResult = {
      exitCode: 0,
      stdout: Buffer.from('hello'),
      stderr: Buffer.from(''),
    };

    const response = await call('sandbox.run', { image: 'node:22-alpine', cmd: ['node', '-v'] });

    expect(response).toMatchObject({
      ok: true,
      result: {
        exit_code: 0,
        timed_out: false,
        stdout: { preview: 'hello', bytes: 5, truncated: false },
      },
    });
  });

  it('bounds a large stream and says so', async () => {
    h.containers.nextResult = { stdout: Buffer.alloc(200_000, 0x61) };

    const response = await call('sandbox.run', { image: 'node:22-alpine', cmd: ['node', '-v'] });
    const result = (response as { result: { stdout: { bytes: number; truncated: boolean } } })
      .result;

    expect(result.stdout.bytes).toBe(200_000);
    expect(result.stdout.truncated).toBe(true);
  });

  it('reports a container the wall clock killed', async () => {
    h.containers.nextResult = { timedOut: true, exitCode: null };

    const response = await call('sandbox.run', { image: 'node:22-alpine', cmd: ['node', '-v'] });
    expect(response).toMatchObject({ ok: true, result: { timed_out: true, exit_code: null } });
  });

  it('reports a driver failure as an error rather than a crash', async () => {
    h.containers.run = async () => {
      throw new Error('runsc: no such runtime');
    };

    const response = await call('sandbox.run', { image: 'node:22-alpine', cmd: ['node', '-v'] });
    expect(response).toMatchObject({ ok: false, error: { code: 'sandbox_failed' } });
  });
});
