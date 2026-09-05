import type { Plan } from '@mycelium/contracts';

/**
 * The plan-level token ceiling, pure.
 *
 * `limits.tokens` bounds one task per attempt and nothing bounds the plan, so
 * a plan that goes wrong is limited only by the provider-console spend cap on
 * the API key (baseline §7) — account-wide and terminal, which means every
 * plan stops at once with a provider error rather than one plan failing with a
 * manifest saying why. Ticket 0005 part B.
 *
 * Nothing new is measured here. `tasks.tokens_spent` is already written from
 * the agent's status report and already summed per plan at finalize; this is a
 * gate over data that exists.
 */

/**
 * Defaulting to the sum of the task ceilings means a plan that names nothing
 * gets exactly the guarantee it already looks like it has, so this is additive
 * for every plan written before it. Naming `max_tokens` is how an operator
 * asks for less — or, legitimately, for more: task ceilings are per attempt,
 * and a plan with retries can pass their sum without anything being wrong.
 */
export function planTokenCeiling(plan: Plan): number {
  if (plan.max_tokens !== undefined) return plan.max_tokens;
  return plan.tasks.reduce((sum, task) => sum + task.limits.tokens, 0);
}

export interface CeilingCheck {
  /**
   * Spend on every task on this plan **except** the one about to be
   * dispatched. Excluding it is not a detail: `limits.tokens` is task-wide
   * across execution attempts, so a retry's worst case is still that one
   * ceiling. Counting the earlier attempt's spend *and* the full ceiling again
   * would charge the same allowance twice and make every retry impossible —
   * a plan whose only task had spent anything could never be retried at all.
   */
  spentOnOtherTasks: number;
  /** `limits.tokens` for the task about to be dispatched, across all its attempts. */
  taskCeiling: number;
  planCeiling: number;
}

/**
 * Checked against the task's ceiling rather than a guess at what it will
 * actually use. A gate that let a task start on the hope it would come in
 * under budget would be a ceiling that holds only for well-behaved plans,
 * which is the opposite of what a ceiling is for.
 */
export function wouldCrossCeiling(check: CeilingCheck): boolean {
  return check.spentOnOtherTasks + check.taskCeiling > check.planCeiling;
}
