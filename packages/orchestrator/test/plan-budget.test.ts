import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tick } from '../src/services/dispatcher.js';
import { buildTestApp, bearer, type TestHarness } from './helpers/app.js';
import {
  eventTypes,
  planState,
  runningPlan,
  taskState,
  validPlan,
  type RunningPlan,
} from './helpers/fixtures.js';

/**
 * The plan-level token ceiling (ticket 0005 part B).
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

/** Two tasks, no dependency between them, each with the same ceiling. */
function twoTaskPlan(taskTokens: number, maxTokens?: number): Record<string, unknown> {
  return {
    ...validPlan(),
    ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
    max_concurrent_agents: 1,
    tasks: [
      { id: 'first', description: 'The first thing.', limits: { tokens: taskTokens, wall_clock_min: 10 } },
      { id: 'second', description: 'The second thing.', limits: { tokens: taskTokens, wall_clock_min: 10 } },
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

/** Runs the first task to completion, spending what the test says. */
async function finishFirst(running: RunningPlan, tokensSpent: number): Promise<void> {
  const first = running.taskIds.first as string;
  await report(running, first, { state: 'running' });
  await report(running, first, { state: 'done', tokens_spent: tokensSpent });
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
    // 9000 spent, a 1000-token ceiling, and a 10000 plan ceiling: it fits, and
    // a boundary that refused here would be off by one in the expensive
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
  });

  it('still writes a manifest, which is why it halts rather than stalls', async () => {
    const running = await runningPlan(h, twoTaskPlan(1000, 1500));
    await finishFirst(running, 900);

    await tick(h.deps);

    const { rows } = await h.pool.query<{ manifest: { tokens_spent?: number } | null }>(
      'SELECT manifest FROM plans WHERE id = $1',
      [running.planId],
    );
    // A plan that ran out of budget is a plan the operator has to be told
    // about, with the numbers attached.
    expect(rows[0]?.manifest).not.toBeNull();
    expect(rows[0]?.manifest?.tokens_spent).toBe(900);
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
    // A failed attempt spent its tokens too; not counting them would let a
    // plan of failures run for ever.
    await report(running, first, { state: 'failed', tokens_spent: 900, error: 'nope' });

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
});

describe('a plan that names no ceiling', () => {
  it('gets the sum of its task ceilings, so nothing written before this changes', async () => {
    const running = await runningPlan(h, twoTaskPlan(1000));
    await finishFirst(running, 900);

    await tick(h.deps);

    expect(await taskState(h, running.taskIds.second as string)).toBe('dispatched');
    expect(await planState(h, running.planId)).toBe('running');
  });

  it('is still halted once the implied ceiling is reached', async () => {
    const running = await runningPlan(h, twoTaskPlan(1000));
    // The implied ceiling is 2000; 1500 spent leaves less than the next
    // task's 1000.
    await finishFirst(running, 1500);

    await tick(h.deps);

    expect(await planState(h, running.planId)).toBe('failed');
  });
});
