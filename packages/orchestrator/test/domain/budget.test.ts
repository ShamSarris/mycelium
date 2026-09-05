import { describe, expect, it } from 'vitest';
import { planTokenCeiling, wouldCrossCeiling } from '../../src/domain/budget.js';
import type { Plan } from '@mycelium/contracts';

/**
 * `limits.tokens` is per task, so a plan with forty tasks has forty
 * independent ceilings and no aggregate. The only backstop today is the
 * provider-console spend limit on the API key, which is account-wide and
 * terminal: when it trips every plan stops at once with a provider error
 * rather than a manifest naming which plan overspent. Ticket 0005 part B.
 */

function plan(tasks: number[], maxTokens?: number): Plan {
  return {
    goal: 'g',
    project: { name: 'demo' },
    assumptions: ['a'],
    env: 'dev',
    success_criteria: [{ type: 'all_tasks_done' }],
    ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
    tasks: tasks.map((tokens, index) => ({
      id: `t${index + 1}`,
      description: 'do a thing',
      limits: { tokens, wall_clock_min: 30 },
    })),
  } as unknown as Plan;
}

describe('planTokenCeiling', () => {
  it('defaults to the sum of the task ceilings', () => {
    // The number the plan already implies, so this change is additive for
    // every plan written before it.
    expect(planTokenCeiling(plan([10_000, 20_000, 5000]))).toBe(35_000);
  });

  it('takes a smaller number when the plan names one', () => {
    expect(planTokenCeiling(plan([10_000, 20_000], 12_000))).toBe(12_000);
  });

  it('takes a larger number when the plan names one', () => {
    // Naming a larger ceiling is legitimate: task ceilings are per attempt,
    // and a plan with retries can exceed their sum honestly.
    expect(planTokenCeiling(plan([10_000], 50_000))).toBe(50_000);
  });

  it('handles a single-task plan', () => {
    expect(planTokenCeiling(plan([7000]))).toBe(7000);
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
    // A single-task plan whose task has a 100 ceiling and has already spent 40
    // on a failed attempt. `limits.tokens` is task-wide across attempts, so the
    // worst case is still 100 — charging 40 + 100 would make every retry
    // impossible, which is what the existing dispatch suite caught.
    expect(
      wouldCrossCeiling({ spentOnOtherTasks: 0, taskCeiling: 100, planCeiling: 100 }),
    ).toBe(false);
  });
});
