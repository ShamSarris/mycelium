import type { TaskDispatch } from '../protocol.js';

/**
 * Everything above the point where a task is actually executed: whatever
 * turns a dispatch into a `TaskOutcome`, whether that is the host-owned loop
 * (`HostLoopRunner`) or an agent framework that owns its own loop internally.
 *
 * This is now the only seam an agent framework is allowed behind — the note
 * that used to describe `ModelTransport` (`transport/transport.ts`), before
 * the framework grew to own the turn loop itself rather than just answering
 * it one request at a time. `ModelTransport` still exists and `HostLoopRunner`
 * still calls it, but nothing above this interface knows that.
 */
export interface TaskRunner {
  run(dispatch: TaskDispatch, signal: AbortSignal): Promise<TaskOutcome>;
}

export interface TaskOutcome {
  state: 'done' | 'failed';
  /**
   * Task-wide across execution attempts, which is what the status route
   * expects. Authoritative (ticket 03), but currently just mirrors
   * `tokensSpent`: `domain/budget.ts` is not converted to cost (ticket 07
   * decision — it is deleted by ticket 14), so there is no real cost figure
   * to report yet. Real cost tracking arrives with tickets 09-11.
   */
  costMicrousd: number;
  /** Task-wide across execution attempts, kept as a detail alongside cost. */
  tokensSpent: number;
  result?: unknown;
  error?: string;
}
