import type { TaskDispatch } from '../protocol.js';

/**
 * Everything above the point where a task is actually executed: whatever
 * turns a dispatch into a `TaskOutcome`. `AgentSdkRunner` (`runner/agent-sdk.ts`)
 * is the only implementation since ticket 14 deleted the host-owned loop and
 * the per-request model-call seam (`transport/transport.ts`, deleted with it)
 * it drove one turn at a time. Nothing above this interface knows how the
 * implementation behind it turns a dispatch into an outcome.
 */
export interface TaskRunner {
  run(dispatch: TaskDispatch, signal: AbortSignal): Promise<TaskOutcome>;
}

export interface TaskOutcome {
  state: 'done' | 'failed';
  /**
   * Task-wide across execution attempts, which is what the status route
   * normally expects. It is absent when the SDK ended without its final usage
   * report: tokens observed in intermediate messages are not a price.
   */
  costMicrousd?: number;
  /** Task-wide across execution attempts, kept as a detail alongside cost. */
  tokensSpent: number;
  result?: unknown;
  error?: string;
}
