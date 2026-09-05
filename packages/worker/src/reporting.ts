import type { Deps } from './deps.js';
import { StatusRejected, type StatusReport } from './orchestrator.js';

/**
 * Reporting a task's state, with the retry policy around it.
 *
 * This never throws. A report that cannot be delivered is a report the
 * orchestrator will infer from the task's lease expiring instead — worse, but
 * survivable — whereas a throw here would escape the loop after the work was
 * already done. What the agent owes in that case is a record of what it tried
 * to say, which is the `error` event.
 */

export interface ReportOptions {
  /** Retries after the first attempt. Shutdown passes 0; there is no room. */
  retries?: number;
  /** Overrides the client's own deadline. Shutdown passes a much shorter one. */
  timeoutMs?: number;
}

export async function reportStatus(
  deps: Deps,
  taskId: string,
  report: StatusReport,
  options: ReportOptions = {},
): Promise<void> {
  const retries = options.retries ?? deps.config.statusRetryLimit;
  const window = deps.config.statusRetryWindowMs;

  let attempt = 0;
  let elapsed = 0;
  let lastError: unknown;

  for (;;) {
    try {
      await deps.orchestrator.reportStatus(taskId, report, options.timeoutMs);
      return;
    } catch (error) {
      lastError = error;

      // A 4xx means the body is wrong. Re-sending the same body cannot fix it,
      // and would only delay the event that says so.
      if (error instanceof StatusRejected) break;
      if (attempt >= retries) break;

      const delay = backoff(attempt);
      if (elapsed + delay > window) break;

      await deps.sleep(delay);
      elapsed += delay;
      attempt += 1;
    }
  }

  await deps.broker.emit({
    type: 'error',
    severity: 'error',
    taskId,
    payload: {
      stage: 'status_report',
      state: report.state,
      attempts: attempt + 1,
      message: (lastError as Error | undefined)?.message ?? 'unknown',
    },
  });
}

/** 1s, 2s, 4s. Well inside the default window, and increasing. */
function backoff(attempt: number): number {
  return 1000 * 2 ** attempt;
}
