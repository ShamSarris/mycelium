import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, operatorHeaders, type TestHarness } from './helpers/app.js';
import { propose, validPlan } from './helpers/fixtures.js';

/**
 * What the approval gate shows.
 *
 * Baseline §5 step 3 says assumptions are echoed to the operator before
 * approval. Assumptions alone are not the whole of what is being approved: the
 * non-goals are the only thing stopping an agent widening its own scope, and
 * the ceilings are what stops it spending the month. A gate that hides them is
 * a gate that approves something narrower than what runs. Ticket 0006 §4.
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

async function show(planId: string) {
  const response = await h.app.inject({
    method: 'GET',
    url: `/plans/${planId}`,
    headers: operatorHeaders(),
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as { plan: Record<string, unknown> };
}

describe('the plan the operator is asked to approve', () => {
  it('shows the non-goals, which are what bound the agent', async () => {
    const { plan_id } = await propose(h, {
      ...validPlan(),
      non_goals: ['Do not touch the deployment pipeline.', 'Do not add a dependency.'],
    });

    const { plan } = await show(plan_id);

    expect(plan.non_goals).toEqual([
      'Do not touch the deployment pipeline.',
      'Do not add a dependency.',
    ]);
  });

  it('shows every ceiling the plan will actually run under', async () => {
    const { plan_id } = await propose(h, {
      ...validPlan(),
      max_cost_microusd: 120_000,
      env_ttl_min: 90,
    });

    const { plan } = await show(plan_id);

    expect(plan.max_cost_microusd).toBe(120_000);
    expect(plan.env_ttl_min).toBe(90);
  });

  it('reports the defaults rather than nothing when the plan named none of them', async () => {
    // `undefined` in the response would read as "no limit" to an operator, and
    // the numbers below are what will actually be enforced.
    const { plan_id } = await propose(h, validPlan());

    const { plan } = await show(plan_id);

    expect(plan.non_goals).toEqual([]);
    expect(plan.env_ttl_min).toBe(240);
    // max_cost_microusd is required (D30) and no longer defaulted or summed
    // from the tasks — the plan gets back exactly what it named.
    expect(plan.max_cost_microusd).toBe((validPlan() as { max_cost_microusd: number }).max_cost_microusd);
  });

  it('still keeps the token hash out of the response', async () => {
    const { plan_id } = await propose(h, validPlan());

    const { plan } = await show(plan_id);

    // Every place it does not appear is a place it cannot leak.
    expect(JSON.stringify(plan)).not.toContain('token_hash');
    expect(plan.agent_token_hash).toBeUndefined();
  });
});
