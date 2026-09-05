import type { Deps } from './deps.js';
import { runTask } from './loop/run.js';
import type { TaskDispatch } from './protocol.js';
import { reportStatus } from './reporting.js';
import { buildRegistry } from './tools/registry.js';

/**
 * One dispatched task, end to end: acknowledge, run, report.
 *
 * The acknowledgement goes first and is not conditional on anything. It is
 * what clears the orchestrator's dispatch lease, and a task that worked first
 * and acknowledged afterwards could lose the lease in the middle of the work.
 * If it cannot be delivered the task still runs — the lease will expire and
 * the orchestrator will act on that, whereas refusing to work because one POST
 * failed would guarantee the failure it was worried about.
 */
export async function runDispatchedTask(
  deps: Deps,
  dispatch: TaskDispatch,
  signal: AbortSignal,
): Promise<void> {
  await reportStatus(deps, dispatch.task_id, { state: 'running' });

  // Per task, so the commit-cadence counter inside it starts fresh and cannot
  // leak from one task into the next.
  const tools = buildRegistry(deps);

  const outcome = await runTask(deps, dispatch, tools, signal);

  await reportStatus(
    deps,
    dispatch.task_id,
    {
      state: outcome.state,
      tokens_spent: outcome.tokensSpent,
      ...(outcome.result === undefined ? {} : { result: outcome.result }),
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
    },
    // A task that ended because the environment is going away reports on
    // shutdown's terms: one attempt, a short deadline. There is no room for a
    // retry inside B15's five seconds, and the lease expiry is the backstop.
    signal.aborted
      ? { retries: 0, timeoutMs: deps.config.shutdownStatusTimeoutMs }
      : {},
  );
}
