import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tick } from '../src/services/dispatcher.js';
import { buildTestApp, bearer, operatorHeaders, type TestHarness } from './helpers/app.js';
import {
  eventTypes,
  planState,
  runningPlan,
  taskState,
  validPlan,
  type RunningPlan,
} from './helpers/fixtures.js';

/**
 * The plan-level cost ceiling (ticket 0005 part B; cost-denominated by D30).
 *
 * Enforced at dispatch, inside the transaction that already locks the plan row
 * to serialise claiming — which is what makes the check and the claim atomic
 * rather than a race two ticks could both win.
 */

let h: TestHarness;

beforeAll(async () => {
  h = await buildTestApp();
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await h.reset();
});

/**
 * Two tasks, each with the same ceiling. `second` depends on `first` so the
 * two dispatch sequentially without needing a concurrency-limit override —
 * `max_concurrent_agents` no longer exists on the plan schema (D30's cost
 * migration dropped it; see ticket 05's report for the concurrency gap).
 */
function twoTaskPlan(taskCostMicrousd: number, maxCostMicrousd: number): Record<string, unknown> {
  return {
    ...validPlan(),
    max_cost_microusd: maxCostMicrousd,
    tasks: [
      {
        id: 'first',
        description: 'The first thing.',
        limits: { cost_microusd: taskCostMicrousd, wall_clock_min: 10 },
      },
      {
        id: 'second',
        description: 'The second thing.',
        depends_on: ['first'],
        limits: { cost_microusd: taskCostMicrousd, wall_clock_min: 10 },
      },
    ],
  };
}

function report(running: RunningPlan, taskId: string, payload: Record<string, unknown>) {
  return h.app.inject({
    method: 'POST',
    url: `/plans/${running.planId}/tasks/${taskId}/status`,
    headers: bearer(running.planToken),
    payload,
  });
}

/**
 * Runs the first task to completion, spending what the test says (in
 * microusd). The status report itself promotes `second` to `ready` (it
 * `depends_on: ['first']`); the caller's own `tick()` is what attempts to
 * dispatch it, which is where the budget gate is checked.
 */
async function finishFirst(running: RunningPlan, costSpentMicrousd: number): Promise<void> {
  const first = running.taskIds.first as string;
  await report(running, first, { state: 'running' });
  await report(running, first, { state: 'done', cost_spent_microusd: costSpentMicrousd });
}

describe('a plan inside its ceiling', () => {
  it('dispatches its tasks normally', async () => {
    const running = await runningPlan(h, twoTaskPlan(1000, 10_000));
    await finishFirst(running, 900);

    await tick(h.deps);

    expect(await planState(h, running.planId)).toBe('running');
    expect(await taskState(h, running.taskIds.second as string)).toBe('dispatched');
  });

  it('dispatches a task that fits exactly', async () => {
    // 9000 spent, a 1000-microusd ceiling, and a 10000 plan ceiling: it fits,
    // and a boundary that refused here would be off by one in the expensive
    // direction.
    const running = await runningPlan(h, twoTaskPlan(1000, 10_000));
    await finishFirst(running, 9000);

    await tick(h.deps);

    expect(await taskState(h, running.taskIds.second as string)).toBe('dispatched');
  });
});

describe('a plan that would cross its ceiling', () => {
  it('is halted instead of dispatching the next task', async () => {
    const running = await runningPlan(h, twoTaskPlan(1000, 1500));
    await finishFirst(running, 900);

    await tick(h.deps);

    // 900 spent plus a 1000 ceiling is 1900, past 1500. Checked against the
    // ceiling rather than a guess at what the task would use.
    //
    // `finalizing` is transient: the same tick finalizes what it halted, so
    // `failed` is what an observer ever sees.
    expect(await planState(h, running.planId)).toBe('failed');
    expect(await taskState(h, running.taskIds.second as string)).toBe('cancelled');
  });

  it('names the reason on the plan, so the manifest says why', async () => {
    const running = await runningPlan(h, twoTaskPlan(1000, 1500));
    await finishFirst(running, 900);

    await tick(h.deps);

    const { rows } = await h.pool.query<{ terminal_reason: string | null }>(
      'SELECT terminal_reason FROM plans WHERE id = $1',
      [running.planId],
    );
    expect(rows[0]?.terminal_reason).toContain('plan_budget_exceeded');
    // Operator-facing prose is money, not a bare integer.
    expect(rows[0]?.terminal_reason).toContain('$');
  });

  it('still writes a manifest, which is why it halts rather than stalls', async () => {
    const running = await runningPlan(h, twoTaskPlan(1000, 1500));
    await finishFirst(running, 900);

    await tick(h.deps);

    const { rows } = await h.pool.query<{
      manifest: { cost_spent_microusd?: number; tokens_spent?: number } | null;
    }>('SELECT manifest FROM plans WHERE id = $1', [running.planId]);
    // A plan that ran out of budget is a plan the operator has to be told
    // about, with the numbers attached. Cost is the authoritative figure.
    expect(rows[0]?.manifest).not.toBeNull();
    expect(rows[0]?.manifest?.cost_spent_microusd).toBe(900);
  });

  it('records it as an event rather than only as a state change', async () => {
    const running = await runningPlan(h, twoTaskPlan(1000, 1500));
    await finishFirst(running, 900);

    await tick(h.deps);

    expect(await eventTypes(h, running.planId)).toContain('limit.exceeded');
  });

  it('counts spend from tasks that failed as well as ones that finished', async () => {
    const running = await runningPlan(h, twoTaskPlan(1000, 1500));
    const first = running.taskIds.first as string;
    await report(running, first, { state: 'running' });
    // A failed attempt spent its cost too; not counting it would let a plan
    // of failures run for ever.
    await report(running, first, { state: 'failed', cost_spent_microusd: 900, error: 'nope' });

    await tick(h.deps);

    expect(await planState(h, running.planId)).toBe('failed');
  });

  it('halts on the first claim when the ceiling is below the first task is limit', async () => {
    // No task should be dispatched at all: the plan was unrunnable as written.
    const running = await runningPlan(h, twoTaskPlan(5000, 1000));

    expect(await planState(h, running.planId)).toBe('failed');
    for (const taskId of Object.values(running.taskIds)) {
      expect(await taskState(h, taskId)).toBe('cancelled');
    }
  });

  it('compares numerically past 2^31 microusd, not lexicographically', async () => {
    // Past int4 (2^31 = 2147483648 microusd, ~$2147.48). The sum is cast
    // `::bigint` in SQL so it does not overflow there; on the JS side
    // src/db/pool.ts's global INT8 type parser hands it back as a number, and
    // this proves the gate compares that total numerically against the
    // ceiling rather than falling back to string comparison somewhere.
    const running = await runningPlan(h, twoTaskPlan(1000, 2_200_001_500));
    await finishFirst(running, 2_200_001_000);

    await tick(h.deps);

    // 2_200_001_000 spent plus a 1000 ceiling is 2_200_002_000, past the
    // 2_200_001_500 plan ceiling.
    expect(await planState(h, running.planId)).toBe('failed');
  });
});

describe('a plan proposed without a cost ceiling', () => {
  it('is rejected at the schema gate rather than defaulted', async () => {
    // max_cost_microusd is required (D30): unlike a token ceiling it cannot
    // be summed from the tasks without a price table, so there is no default
    // left. The old "sums the task ceilings" behaviour is gone entirely.
    const plan = { ...validPlan() } as Record<string, unknown>;
    delete plan.max_cost_microusd;

    const response = await h.app.inject({
      method: 'POST',
      url: '/plans',
      headers: operatorHeaders(),
      payload: plan,
    });

    expect(response.statusCode).toBe(400);
  });
});
