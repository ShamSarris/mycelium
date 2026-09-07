/**
 * How much of a task's cost ceiling one execution attempt may spend.
 *
 * `limits.cost_microusd` is **task-wide across execution attempts** — that is
 * the whole reason the dispatch carries `cost_spent_so_far_microusd`. Handing
 * the SDK the full ceiling on every attempt re-granted the entire budget to a
 * retry, so a task under `retry {max_attempts: 3}` could spend three ceilings
 * before the orchestrator's plan-level check caught it.
 *
 * Pure, and in `domain/` rather than beside the runner, so it is testable
 * without the Agent SDK, a subprocess, or an API key — the same reason
 * `domain/paths.ts` lives here.
 */

/**
 * The smallest budget an attempt is ever given: enough for the agent to boot,
 * look at what the previous attempt left on the branch, and call `task_failed`
 * with something an operator can act on.
 *
 * Without it, a retry of a task whose ceiling was already consumed starts at
 * zero, produces no diagnosis at all, and reports a failure that says nothing —
 * which is exactly the outcome the "failing honestly is better than reporting a
 * success you cannot support" rule exists to avoid. The floor is bounded on
 * both sides: it can never exceed the task's own ceiling (below), and the plan
 * ceiling (`max_cost_microusd`, enforced by the orchestrator before dispatch)
 * remains the real bound on total spend.
 */
export const MIN_ATTEMPT_BUDGET_MICROUSD = 50_000; // $0.05

/**
 * `ceiling - spentSoFar`, floored so an exhausted retry can still speak, and
 * clamped so neither the subtraction nor the floor can hand out more than the
 * operator approved for this task.
 *
 * The clamp is what keeps the floor honest for a task whose whole ceiling is
 * smaller than the floor: such a task gets its ceiling, never the floor.
 */
export function attemptBudgetMicrousd(ceiling: number, spentSoFar: number): number {
  const remaining = ceiling - spentSoFar;
  return Math.min(ceiling, Math.max(remaining, MIN_ATTEMPT_BUDGET_MICROUSD));
}
