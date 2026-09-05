import type { Deps } from './deps.js';
import type { DispatchServer } from './dispatch.js';

/**
 * SIGTERM, from the supervisor's teardown, on completion, cancellation, TTL
 * expiry, or failure.
 *
 * B15 gives five seconds before SIGKILL, and its reasoning is that a flush
 * over a localhost socket needs milliseconds. So the order is: stop the model
 * call, let the task record what happened locally and report it on a short
 * deadline, unlink the socket, exit.
 *
 * There is no rescue push. B15 rejected one explicitly — it makes teardown
 * unbounded, manufactures WIP commits, and contradicts the operator on a
 * cancel. Uncommitted work is lost, and that is the intended trade: the commit
 * cadence is the cure, not teardown heroics.
 */

export type TeardownReason = 'completion' | 'ttl_expired' | 'cancelled' | 'failed';

export interface ShutdownContext {
  deps: Deps;
  server: DispatchServer;
  /** Aborts the model call in flight. Its `reason` is what the failure will name. */
  controller: AbortController;
}

export async function shutdown(context: ShutdownContext, reason: TeardownReason): Promise<void> {
  const { deps, server, controller } = context;

  // The reason rides on the signal so the task's own failure can name it. A
  // task that reported only "aborted" would leave the operator guessing
  // between a cancel and a TTL expiry, which are very different things.
  controller.abort(reason);

  if (server.busy) {
    // Bounded. The task emits its event and reports on shutdown's terms; if it
    // ignores the abort entirely, that is exactly what the SIGKILL behind this
    // window is for, and waiting past the window would only lose the unlink.
    await Promise.race([server.idle(), delay(deps.config.shutdownGraceMs)]);
  }

  await server.close();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    // Unrefed so a pending grace timer cannot itself hold the process open,
    // which would be an odd way for a shutdown path to fail.
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
