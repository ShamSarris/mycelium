import { stat } from 'node:fs/promises';
import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DispatchServer } from '../src/dispatch.js';
import type { TaskDispatch } from '../src/protocol.js';
import { socketAddress } from '../src/socket.js';
import { buildTestWorker, taskDispatch, PLAN_ID, type TestWorker } from './helpers/agent.js';

/**
 * The supervisor's outbound direction (ticket 0003 gap 9): the supervisor
 * dials this socket to hand over a task, and the re-attachment probe dials it
 * to find out whether anything here is still alive.
 *
 * The dispatch answer must come back before the task runs. The orchestrator
 * marks the task dispatched on that answer and the supervisor's route is
 * waiting on it; holding the connection open for the length of a task would
 * time out both.
 */

let h: TestWorker;
let server: DispatchServer;
let started: TaskDispatch[];
let release: (() => void) | null;

/** A task that blocks until the test lets it finish. */
function blockingRunner() {
  return async (dispatch: TaskDispatch): Promise<void> => {
    started.push(dispatch);
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  };
}

function request(payload: unknown, socketPath = h.config.dispatchSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketAddress(socketPath), () => {
      socket.end(`${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n`);
    });
    const chunks: Buffer[] = [];
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error('the agent did not answer'));
    });
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('close', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
  });
}

beforeEach(async () => {
  h = await buildTestWorker();
  started = [];
  release = null;
  server = new DispatchServer(h.deps, blockingRunner());
  await server.listen();
});

afterEach(async () => {
  release?.();
  await server.close();
  await h.close();
});

describe('task.dispatch', () => {
  it('accepts while idle and answers before the task finishes', async () => {
    const dispatch = taskDispatch();

    const answer = await request({ method: 'task.dispatch', params: dispatch });

    expect(answer).toEqual({ ok: true, result: { accepted: true } });
    expect(started).toHaveLength(1);
    expect(started[0]).toEqual(dispatch);
    // Still running: the answer did not wait for it.
    expect(server.busy).toBe(true);
  });

  it('refuses a second task while one is in flight', async () => {
    await request({ method: 'task.dispatch', params: taskDispatch() });

    const answer = await request({
      method: 'task.dispatch',
      params: taskDispatch({ task_id: 'other', local_id: 't2' }),
    });

    // The supervisor turns this into a 409 and the orchestrator returns the
    // task to ready at once, rather than waiting out its lease.
    expect(answer).toEqual({ ok: true, result: { accepted: false } });
    expect(started).toHaveLength(1);
  });

  it('accepts again once the task finishes', async () => {
    await request({ method: 'task.dispatch', params: taskDispatch() });
    release?.();
    await server.idle();

    const answer = await request({
      method: 'task.dispatch',
      params: taskDispatch({ local_id: 't2' }),
    });

    expect(answer).toEqual({ ok: true, result: { accepted: true } });
    expect(started).toHaveLength(2);
  });

  it('accepts again after a task that threw, rather than wedging', async () => {
    await server.close();
    server = new DispatchServer(h.deps, async () => {
      throw new Error('the loop fell over');
    });
    await server.listen();

    await request({ method: 'task.dispatch', params: taskDispatch() });
    await server.idle();

    expect(server.busy).toBe(false);
    const answer = await request({
      method: 'task.dispatch',
      params: taskDispatch({ local_id: 't2' }),
    });
    expect(answer).toEqual({ ok: true, result: { accepted: true } });
  });

  it('refuses a task addressed to another plan', async () => {
    const answer = (await request({
      method: 'task.dispatch',
      params: taskDispatch({ plan_id: 'someone-elses-plan' }),
    })) as { ok: boolean; error?: { code: string } };

    expect(answer.ok).toBe(false);
    expect(answer.error?.code).toBe('wrong_plan');
    expect(started).toHaveLength(0);
  });

  it('refuses a dispatch missing the fields the loop needs', async () => {
    const answer = (await request({
      method: 'task.dispatch',
      params: { plan_id: PLAN_ID, description: 'do a thing' },
    })) as { ok: boolean; error?: { code: string } };

    expect(answer.ok).toBe(false);
    expect(answer.error?.code).toBe('invalid_params');
    expect(started).toHaveLength(0);
  });
});

describe('agent.ping', () => {
  it('names the plan and reports readiness while idle', async () => {
    const answer = await request({ method: 'agent.ping' });

    expect(answer).toEqual({
      ok: true,
      result: { plan_id: PLAN_ID, ready: true, task_id: null },
    });
  });

  it('reports the task in flight, and that it is not ready for another', async () => {
    await request({ method: 'task.dispatch', params: taskDispatch() });

    const answer = (await request({ method: 'agent.ping' })) as {
      result: { ready: boolean; task_id: string | null };
    };

    expect(answer.result.ready).toBe(false);
    expect(answer.result.task_id).toBe(taskDispatch().task_id);
  });

  it('carries nothing else - a probe is not a debugging interface', async () => {
    const answer = (await request({ method: 'agent.ping' })) as { result: Record<string, unknown> };

    expect(Object.keys(answer.result).sort()).toEqual(['plan_id', 'ready', 'task_id']);
  });
});

describe('the server itself', () => {
  it('answers an unknown method without dying', async () => {
    const answer = (await request({ method: 'task.cancel' })) as {
      ok: boolean;
      error?: { code: string };
    };

    expect(answer.ok).toBe(false);
    expect(answer.error?.code).toBe('unknown_method');
    await expect(request({ method: 'agent.ping' })).resolves.toMatchObject({ ok: true });
  });

  it('answers a malformed request without dying', async () => {
    const answer = (await request('{not json')) as { ok: boolean; error?: { code: string } };

    expect(answer.ok).toBe(false);
    expect(answer.error?.code).toBe('invalid_request');
    await expect(request({ method: 'agent.ping' })).resolves.toMatchObject({ ok: true });
  });

  it('answers a request with no method without dying', async () => {
    const answer = (await request({ params: {} })) as { ok: boolean; error?: { code: string } };

    expect(answer.ok).toBe(false);
    await expect(request({ method: 'agent.ping' })).resolves.toMatchObject({ ok: true });
  });

  it.runIf(process.platform !== 'win32')('creates the socket owner-only', async () => {
    const mode = (await stat(h.config.dispatchSocket)).mode & 0o777;

    // Filesystem permissions are the authorisation here, exactly as they are
    // on the supervisor's side of the pair.
    expect(mode).toBe(0o600);
  });

  it.runIf(process.platform !== 'win32')('unlinks the socket on close', async () => {
    await server.close();

    await expect(stat(h.config.dispatchSocket)).rejects.toThrow();
  });

  it('can be closed twice', async () => {
    await server.close();
    await expect(server.close()).resolves.toBeUndefined();
  });
});
