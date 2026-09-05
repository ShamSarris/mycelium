import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTransaction } from '../src/db/pool.js';
import { recordEvent } from '../src/services/events.js';
import { listAlerts } from '../src/services/alerts.js';
import { buildTestApp, OPERATOR, operatorHeaders, type TestHarness } from './helpers/app.js';
import { eventTypes, planState, propose, runningPlan, validPlan } from './helpers/fixtures.js';

/**
 * The four mutating routes, and the check that stops a page in the operator's
 * browser driving them.
 *
 * Serve injects the identity header based on the tailnet connection, not on
 * anything the page proves, so a cross-origin form post would arrive here
 * fully authenticated. Until `/ui` existed the JSON routes were safe only by
 * accident — a form post arrives as urlencoded, which Fastify had no parser
 * for. Adding that parser removed the accident, which is why this check has
 * to be here and has to be tested.
 */

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };

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

function post(url: string, headers: Record<string, string> = SAME_ORIGIN) {
  return h.app.inject({
    method: 'POST',
    url,
    headers: { ...operatorHeaders(), ...headers },
  });
}

describe('the actions', () => {
  it('approves a plan and sends you back to it', async () => {
    const { plan_id } = await propose(h, validPlan());

    const response = await post(`/ui/plans/${plan_id}/approve`);

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(`/ui/plans/${plan_id}`);
    expect(await planState(h, plan_id)).toBe('queued');
  });

  it('rejects a plan', async () => {
    const { plan_id } = await propose(h, validPlan());

    await post(`/ui/plans/${plan_id}/reject`);

    expect(await planState(h, plan_id)).toBe('rejected');
  });

  it('cancels a running plan, which is the budget brake', async () => {
    const running = await runningPlan(h, validPlan());

    await post(`/ui/plans/${running.planId}/cancel`);

    expect(await planState(h, running.planId)).toBe('cancelled');
  });

  it('acknowledges an alert and sends you back to the overview', async () => {
    const { plan_id } = await propose(h, validPlan());
    const eventId = await withTransaction(h.pool, (client) =>
      recordEvent(client, h.deps, {
        type: 'error',
        severity: 'error',
        planId: plan_id,
        payload: { stage: 'model_call' },
      }),
    );

    const response = await post(`/ui/alerts/${eventId}/ack`);

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe('/ui');
    expect(await listAlerts(h.deps)).toHaveLength(0);
  });

  it('attributes every action to the operator who took it', async () => {
    const { plan_id } = await propose(h, validPlan());

    await post(`/ui/plans/${plan_id}/approve`);

    const { rows } = await h.pool.query<{ approved_by: string }>(
      'SELECT approved_by FROM plans WHERE id = $1',
      [plan_id],
    );
    expect(rows[0]?.approved_by).toBe(OPERATOR);
    expect(await eventTypes(h, plan_id)).toContain('plan.state_changed');
  });

  it('redirects with 303, so a reload does not repeat the action', async () => {
    const { plan_id } = await propose(h, validPlan());

    // 302 would let a browser re-POST on reload. On an approve that is
    // harmless; on a cancel it is not.
    expect((await post(`/ui/plans/${plan_id}/approve`)).statusCode).toBe(303);
  });
});

describe('cross-site requests', () => {
  it('refuses one whose Sec-Fetch-Site says cross-site, and does nothing', async () => {
    const { plan_id } = await propose(h, validPlan());

    const response = await post(`/ui/plans/${plan_id}/approve`, {
      'sec-fetch-site': 'cross-site',
    });

    expect(response.statusCode).toBe(403);
    expect(await planState(h, plan_id)).toBe('proposed');
  });

  it('refuses same-site, which is not the same origin', async () => {
    const { plan_id } = await propose(h, validPlan());

    const response = await post(`/ui/plans/${plan_id}/approve`, { 'sec-fetch-site': 'same-site' });

    expect(response.statusCode).toBe(403);
    expect(await planState(h, plan_id)).toBe('proposed');
  });

  it('refuses one whose Origin is another host', async () => {
    const { plan_id } = await propose(h, validPlan());

    const response = await post(`/ui/plans/${plan_id}/approve`, {
      origin: 'https://evil.example.com',
      host: 'orchestrator.tailnet',
    });

    expect(response.statusCode).toBe(403);
    expect(await planState(h, plan_id)).toBe('proposed');
  });

  it('allows one whose Origin matches the host', async () => {
    const { plan_id } = await propose(h, validPlan());

    const response = await post(`/ui/plans/${plan_id}/approve`, {
      origin: 'https://orchestrator.tailnet',
      host: 'orchestrator.tailnet',
    });

    expect(response.statusCode).toBe(303);
    expect(await planState(h, plan_id)).toBe('queued');
  });

  it('allows a direct navigation, which carries Sec-Fetch-Site: none', async () => {
    const { plan_id } = await propose(h, validPlan());

    expect((await post(`/ui/plans/${plan_id}/approve`, { 'sec-fetch-site': 'none' })).statusCode).toBe(
      303,
    );
  });

  it('refuses a request carrying neither header, because that is not a browser', async () => {
    const { plan_id } = await propose(h, validPlan());

    const response = await h.app.inject({
      method: 'POST',
      url: `/ui/plans/${plan_id}/approve`,
      headers: operatorHeaders(),
    });

    expect(response.statusCode).toBe(403);
    expect(await planState(h, plan_id)).toBe('proposed');
  });

  it('refuses a malformed Origin rather than trying to interpret it', async () => {
    const { plan_id } = await propose(h, validPlan());

    const response = await post(`/ui/plans/${plan_id}/approve`, {
      origin: 'not a url',
      host: 'orchestrator.tailnet',
    });

    expect(response.statusCode).toBe(403);
  });

  it('applies to acknowledgement too, not just the plan actions', async () => {
    const { plan_id } = await propose(h, validPlan());
    const eventId = await withTransaction(h.pool, (client) =>
      recordEvent(client, h.deps, { type: 'error', severity: 'error', planId: plan_id, payload: {} }),
    );

    const response = await post(`/ui/alerts/${eventId}/ack`, { 'sec-fetch-site': 'cross-site' });

    expect(response.statusCode).toBe(403);
    expect(await listAlerts(h.deps)).toHaveLength(1);
  });
});

describe('identity still decides', () => {
  it('refuses an action from a login that is not on the allowlist', async () => {
    const { plan_id } = await propose(h, validPlan());

    const response = await h.app.inject({
      method: 'POST',
      url: `/ui/plans/${plan_id}/approve`,
      headers: { 'tailscale-user-login': 'nobody@example.com', ...SAME_ORIGIN },
    });

    // The origin check is about *where the request came from*; the allowlist
    // is about *who*. Both have to hold.
    expect(response.statusCode).toBe(403);
    expect(await planState(h, plan_id)).toBe('proposed');
  });

  it('refuses an action with no identity at all', async () => {
    const { plan_id } = await propose(h, validPlan());

    const response = await h.app.inject({
      method: 'POST',
      url: `/ui/plans/${plan_id}/approve`,
      headers: SAME_ORIGIN,
    });

    expect(response.statusCode).toBe(401);
  });
});
