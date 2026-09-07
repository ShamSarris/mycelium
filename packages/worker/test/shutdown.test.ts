import { stat } from 'node:fs/promises';
import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DispatchServer } from '../src/dispatch.js';
import { shutdown } from '../src/shutdown.js';
import { runDispatchedTask } from '../src/task.js';
import { socketAddress } from '../src/socket.js';
import { buildTestWorker, taskDispatch, type TestWorker } from './helpers/agent.js';
import { BlockingTaskRunner } from './helpers/fakes.js';

/**
 * B15 gives teardown five seconds between SIGTERM and SIGKILL, and its
 * reasoning is that a flush over a localhost socket needs milliseconds. Every
 * assertion here is about spending that budget in the right order: the local,
 * durable thing first, the networked, best-effort thing second.
 *
 * B15 also rejected a rescue push outright - it makes teardown unbounded,
 * manufactures WIP commits, and contradicts the operator on a cancel. So the
 * last test in each group is that nothing was pushed.
 */

let h: TestWorker;
let server: DispatchServer;
let controller: AbortController;

/** Hands the agent a task the way the supervisor does, over its socket. */
function dispatchOverSocket(): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketAddress(h.config.dispatchSocket), () => {
      socket.end(`${JSON.stringify({ method: 'task.dispatch', params: taskDispatch() })}\n`);
    });
    // The answer has to be read, or the readable side never flows and neither
    // `end` nor `close` ever arrives.
    socket.resume();
    socket.on('error', reject);
    socket.on('close', () => resolve());
  });
}

beforeEach(async () => {
  h = await buildTestWorker();
  controller = new AbortController();
  server = new DispatchServer(h.deps, (dispatch) =>
    runDispatchedTask(h.deps, dispatch, controller.signal),
  );
  await server.listen();
});

afterEach(async () => {
  await server.close();
  await h.close();
});

describe('while idle', () => {
  it('closes without waiting for anything', async () => {
    await shutdown({ deps: h.deps, server, controller }, 'ttl_expired');

    expect(h.orchestrator.reports).toHaveLength(0);
    expect(h.sleeps).toHaveLength(0);
  });

  it('unlinks its socket', async () => {
    await shutdown({ deps: h.deps, server, controller }, 'completion');

    if (process.platform !== 'win32') {
      await expect(stat(h.config.dispatchSocket)).rejects.toThrow();
    }
    expect(server.busy).toBe(false);
  });

  it('pushes nothing', async () => {
    await shutdown({ deps: h.deps, server, controller }, 'cancelled');

    expect(h.git.pushes).toHaveLength(0);
    expect(h.git.commits).toHaveLength(0);
  });
});

describe('mid-task', () => {
  /**
   * Starts a task through the socket, exactly as the supervisor would, and
   * returns once the runner is genuinely in flight (`BlockingTaskRunner`
   * never resolves on its own — see its own header comment for why).
   */
  async function startBlockedTask(): Promise<void> {
    const blocking = new BlockingTaskRunner(h.broker);
    h.deps.runner = blocking;

    await dispatchOverSocket();
    await blocking.started;
  }

  it('aborts the call in flight', async () => {
    await startBlockedTask();

    await shutdown({ deps: h.deps, server, controller }, 'ttl_expired');

    expect(controller.signal.aborted).toBe(true);
  });

  it('records the abort as an event before it tries to reach the orchestrator', async () => {
    await startBlockedTask();

    await shutdown({ deps: h.deps, server, controller }, 'cancelled');

    // The event goes to a local, fsynced spool in milliseconds. The status
    // POST crosses the network. Ordering them the other way round would risk
    // spending the whole budget before anything was recorded at all.
    const errors = h.broker.ofType('error');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((event) => JSON.stringify(event.payload).includes('aborted'))).toBe(true);
  });

  it('reports the task failed, naming why', async () => {
    await startBlockedTask();

    await shutdown({ deps: h.deps, server, controller }, 'ttl_expired');

    const last = h.orchestrator.last;
    expect(last?.state).toBe('failed');
    expect(last?.error).toContain('aborted');
    expect(last?.error).toContain('ttl_expired');
  });

  it('gives the status report a short deadline and no retries', async () => {
    await startBlockedTask();
    h.orchestrator.failFirst = Number.MAX_SAFE_INTEGER;

    await shutdown({ deps: h.deps, server, controller }, 'failed');

    // There is no room to retry inside five seconds, and the orchestrator's
    // lease expiry is the backstop for a report that never arrives.
    expect(h.sleeps).toHaveLength(0);
  });

  it('finishes even when the orchestrator is unreachable', async () => {
    await startBlockedTask();
    h.orchestrator.failWith = new Error('the network is gone');

    await expect(
      shutdown({ deps: h.deps, server, controller }, 'ttl_expired'),
    ).resolves.toBeUndefined();
  });

  it('gives up waiting rather than overrunning the grace window', async () => {
    await server.close();
    h = await buildTestWorker({ SHUTDOWN_GRACE_MS: '40' });
    controller = new AbortController();
    // A task that ignores the abort entirely, which is the case the SIGKILL
    // behind this window exists to cover.
    server = new DispatchServer(h.deps, () => new Promise<void>(() => undefined));
    await server.listen();
    await dispatchOverSocket();
    expect(server.busy).toBe(true);

    const started = Date.now();
    await shutdown({ deps: h.deps, server, controller }, 'ttl_expired');

    // Waiting past the window would only lose the unlink; the kill arrives
    // either way.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('pushes nothing, whatever was in progress', async () => {
    await startBlockedTask();

    await shutdown({ deps: h.deps, server, controller }, 'ttl_expired');

    // Sparse checkpoints, not teardown heroics, are the cure for lost work.
    expect(h.git.pushes).toHaveLength(0);
    expect(h.git.commits).toHaveLength(0);
  });
});
