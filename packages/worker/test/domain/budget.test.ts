import { describe, expect, it } from 'vitest';
import { MIN_ATTEMPT_BUDGET_MICROUSD, attemptBudgetMicrousd } from '../../src/domain/budget.js';

/**
 * `limits.cost_microusd` is task-wide across execution attempts, which is why
 * the dispatch carries `cost_spent_so_far_microusd` at all. Handing the SDK the
 * whole ceiling on every attempt re-granted the full budget to a retry, so a
 * task under `retry {max_attempts: 3}` could spend three ceilings.
 *
 * The floor is the one deliberate exception: an attempt that can afford nothing
 * produces no diagnosis, and "failing honestly" is worth more than the last few
 * cents of a ceiling that is already spent.
 */
describe('attemptBudgetMicrousd', () => {
  it('grants the whole ceiling on a first attempt', () => {
    expect(attemptBudgetMicrousd(2_500_000, 0)).toBe(2_500_000);
  });

  it('grants only what the ceiling has left on a retry', () => {
    expect(attemptBudgetMicrousd(1_000_000, 400_000)).toBe(600_000);
  });

  it('never exceeds the task ceiling, whatever the prior spend', () => {
    for (const spent of [0, 1, 500_000, 999_999, 1_000_000, 5_000_000]) {
      expect(attemptBudgetMicrousd(1_000_000, spent)).toBeLessThanOrEqual(1_000_000);
    }
  });

  it('floors an exhausted retry so it can still boot and report a failure', () => {
    expect(attemptBudgetMicrousd(1_000_000, 1_000_000)).toBe(MIN_ATTEMPT_BUDGET_MICROUSD);
    expect(attemptBudgetMicrousd(1_000_000, 2_000_000)).toBe(MIN_ATTEMPT_BUDGET_MICROUSD);
  });

  it('never returns a negative budget when prior spend overran the ceiling', () => {
    expect(attemptBudgetMicrousd(100_000, 999_999_999)).toBeGreaterThan(0);
  });

  /**
   * The floor must not become a way to spend more than the operator approved on
   * a task whose ceiling is smaller than the floor itself.
   */
  it('clamps the floor to the ceiling for a task cheaper than the floor', () => {
    const tiny = 10_000; // $0.01, well under the floor
    expect(attemptBudgetMicrousd(tiny, tiny)).toBe(tiny);
    expect(attemptBudgetMicrousd(tiny, 0)).toBe(tiny);
  });

  it('treats a spend that exactly meets the ceiling the same as one that overran it', () => {
    expect(attemptBudgetMicrousd(800_000, 800_000)).toBe(attemptBudgetMicrousd(800_000, 900_000));
  });
});
