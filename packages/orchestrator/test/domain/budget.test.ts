import { describe, expect, it } from 'vitest';
import { planCostCeiling, wouldCrossCeiling } from '../../src/domain/budget.js';
import type { Plan } from '@mycelium/contracts';

/**
 * `limits.cost_microusd` is per task, so a plan with forty tasks has forty
 * independent ceilings and no aggregate on its own. `max_cost_microusd` is
 * the plan-wide backstop (D30) — required on every plan, because unlike a
 * token ceiling it cannot be inferred from the tasks without a price table.
 */

function plan(tasks: number[], maxCostMicrousd?: number): Plan {
  return {
    goal: 'g',
    project: { name: 'demo' },
    assumptions: ['a'],
    env: 'dev',
    success_criteria: [{ type: 'all_tasks_done' }],
    ...(maxCostMicrousd === undefined ? {} : { max_cost_microusd: maxCostMicrousd }),
    tasks: tasks.map((cost_microusd, index) => ({
      id: `t${index + 1}`,
      description: 'do a thing',
      limits: { cost_microusd, wall_clock_min: 30 },
    })),
  } as unknown as Plan;
}

describe('planCostCeiling', () => {
  it('reads the plan-named ceiling', () => {
    expect(planCostCeiling(plan([10_000, 20_000], 12_000))).toBe(12_000);
  });

  it('takes a ceiling larger than the sum of the task ceilings', () => {
    // Legitimate: task ceilings are per attempt, and a plan with retries can
    // exceed their sum honestly.
    expect(planCostCeiling(plan([10_000], 50_000))).toBe(50_000);
  });

  it('handles a single-task plan', () => {
    expect(planCostCeiling(plan([7000], 7000))).toBe(7000);
  });

  it('throws rather than invent a ceiling when the plan names none', () => {
    // The schema now requires max_cost_microusd (D30): unlike a token ceiling
    // it cannot be summed from the tasks without a price table, so there is
    // no default left to fall back to. A plan reaching here without one is a
    // validation gap upstream, not something this function should paper over.
    expect(() => planCostCeiling(plan([10_000, 20_000]))).toThrow();
  });
});

describe('wouldCrossCeiling', () => {
  it('allows a task that fits', () => {
    expect(wouldCrossCeiling({ spentOnOtherTasks: 5000, taskCeiling: 4000, planCeiling: 10_000 })).toBe(false);
  });

  it('allows a task that fits exactly', () => {
    expect(wouldCrossCeiling({ spentOnOtherTasks: 6000, taskCeiling: 4000, planCeiling: 10_000 })).toBe(false);
  });

  it('refuses a task whose ceiling would cross, even though it might not spend it', () => {
    // Against the ceiling, not against a guess at what the task will use. A
    // gate that let a task start on the hope it comes in under budget is a
    // ceiling that only holds for well-behaved plans.
    expect(wouldCrossCeiling({ spentOnOtherTasks: 7000, taskCeiling: 4000, planCeiling: 10_000 })).toBe(true);
  });

  it('refuses a first task larger than the whole plan ceiling', () => {
    expect(
      wouldCrossCeiling({ spentOnOtherTasks: 0, taskCeiling: 20_000, planCeiling: 10_000 }),
    ).toBe(true);
  });

  it('does not charge a retrying task its own earlier spend as well as its ceiling', () => {
    // A single-task plan whose task has a 100-microusd ceiling and has
    // already spent 40 on a failed attempt. `limits.cost_microusd` is
    // task-wide across attempts, so the worst case is still 100 — charging
    // 40 + 100 would make every retry impossible.
    expect(
      wouldCrossCeiling({ spentOnOtherTasks: 0, taskCeiling: 100, planCeiling: 100 }),
    ).toBe(false);
  });

  it('compares numerically past 2^31, not lexicographically', () => {
    // 2^31 = 2147483648 microusd (~$2147.48), where int4 overflows. Plain
    // arithmetic comparison here, well past that boundary and well within
    // Number.MAX_SAFE_INTEGER, is what the integration suite
    // (plan-budget.test.ts) then exercises end to end through the real
    // `sum(cost_spent_microusd)::bigint` query.
    const spentOnOtherTasks = 2_200_000_000;
    expect(
      wouldCrossCeiling({ spentOnOtherTasks, taskCeiling: 1000, planCeiling: 2_200_000_500 }),
    ).toBe(true);
    expect(
      wouldCrossCeiling({ spentOnOtherTasks, taskCeiling: 1000, planCeiling: 2_200_001_500 }),
    ).toBe(false);
  });
});
