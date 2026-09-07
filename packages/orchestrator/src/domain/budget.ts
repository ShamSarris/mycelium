import type { Plan } from '@mycelium/contracts';

/**
 * The plan-level cost ceiling, pure.
 *
 * `limits.cost_microusd` bounds one task per attempt and nothing bounds the
 * plan, so a plan that goes wrong is limited only by the provider-console
 * spend cap on the API key (baseline §7) — account-wide and terminal, which
 * means every plan stops at once with a provider error rather than one plan
 * failing with a manifest saying why. Ticket 0005 part B; unit converted from
 * tokens to microusd by D30 (ticket agent-sdk-migration/05).
 *
 * Nothing new is measured here. `tasks.cost_spent_microusd` is already
 * written from the agent's status report and already summed per plan at
 * finalize; this is a gate over data that exists.
 */

/**
 * `max_cost_microusd` is required on every plan (D30): unlike a token
 * ceiling it cannot be inferred from the tasks, because nothing in this
 * process holds a price table to convert one into the other. There is no
 * default here any more — a plan reaching this function without one is a
 * validation gap upstream (the schema marks it required), not something this
 * function should paper over by inventing a number.
 */
export function planCostCeiling(plan: Plan): number {
  if (typeof plan.max_cost_microusd !== 'number') {
    throw new Error('plan.max_cost_microusd is required and missing');
  }
  return plan.max_cost_microusd;
}

export interface CeilingCheck {
  /**
   * Spend, in microusd, on every task on this plan **except** the one about
   * to be dispatched. Excluding it is not a detail: `limits.cost_microusd` is
   * task-wide across execution attempts, so a retry's worst case is still
   * that one ceiling. Counting the earlier attempt's spend *and* the full
   * ceiling again would charge the same allowance twice and make every retry
   * impossible — a plan whose only task had spent anything could never be
   * retried at all.
   */
  spentOnOtherTasks: number;
  /** `limits.cost_microusd` for the task about to be dispatched, across all its attempts. */
  taskCeiling: number;
  /** `max_cost_microusd` for the whole plan, in microusd. */
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
