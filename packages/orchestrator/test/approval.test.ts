import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tick } from '../src/services/dispatcher.js';
import { buildTestApp, bearer, operatorHeaders, type TestHarness } from './helpers/app.js';
import {
  approve,
  planState,
  propose,
  registerSupervisor,
  runningPlan,
  validPlan,
} from './helpers/fixtures.js';

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

function act(planId: string, action: 'approve' | 'reject' | 'cancel', headers = operatorHeaders()) {
  return h.app.inject({ method: 'POST', url: `/plans/${planId}/${action}`, headers });
}

describe('approve', () => {
  it('moves the plan to queued and records who approved it', async () => {
    const { plan_id } = await propose(h);
    const response = await act(plan_id, 'approve');

    expect(response.statusCode).toBe(200);
    expect(response.json().state).toBe('queued');

    const { rows } = await h.pool.query<{ approved_by: string; approved_at: Date | null }>(
      'SELECT approved_by, approved_at FROM plans WHERE id = $1',
      [plan_id],
    );
    expect(rows[0]?.approved_by).toBe('sam@example.com');
    expect(rows[0]?.approved_at).not.toBeNull();
  });

  it('creates the plan branch and a repo-scoped bot token', async () => {
    const { plan_id } = await propose(h);
    await approve(h, plan_id);

    expect(h.gitea.createBranchCalls).toEqual([{ repo: 'demo', branch: `plan/${plan_id}` }]);
    expect(h.gitea.createBotTokenCalls).toEqual([{ repo: 'demo', planId: plan_id }]);
  });

  it('stores the hash of the per-plan token and never the token itself', async () => {
    const { plan_id } = await propose(h);
    await approve(h, plan_id);

    const secrets = h.deps.tokens.get(plan_id);
    expect(secrets?.orchestratorToken).toMatch(/^[0-9a-f]{64}$/);

    const { rows } = await h.pool.query<{ agent_token_hash: string }>(
      'SELECT agent_token_hash FROM plans WHERE id = $1',
      [plan_id],
    );
    expect(rows[0]?.agent_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.agent_token_hash).not.toBe(secrets?.orchestratorToken);
  });

  it('leaks neither the plan token nor the bot token into any event payload', async () => {
    const { plan_id } = await propose(h);
    await approve(h, plan_id);
    const secrets = h.deps.tokens.get(plan_id);

    const { rows } = await h.pool.query<{ payload: unknown }>('SELECT payload FROM events');
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(secrets?.orchestratorToken);
    expect(dump).not.toContain(secrets?.giteaBotToken);
  });

  it('is idempotent: a second approval does no further Gitea work', async () => {
    const { plan_id } = await propose(h);
    await approve(h, plan_id);
    const second = await act(plan_id, 'approve');

    expect(second.statusCode).toBe(200);
    expect(second.json().already_approved).toBe(true);
    expect(h.gitea.createBranchCalls).toHaveLength(1);
    expect(h.gitea.createBotTokenCalls).toHaveLength(1);
  });

  it('retries repo creation that propose failed at', async () => {
    h.gitea.throwAlways.add('ensureRepo');
    const { plan_id } = await propose(h);
    h.gitea.throwAlways.delete('ensureRepo');

    await approve(h, plan_id);
    expect(h.gitea.ensureRepoCalls).toEqual(['demo']);
  });

  it('refuses to approve a rejected plan', async () => {
    const { plan_id } = await propose(h);
    await act(plan_id, 'reject');

    const response = await act(plan_id, 'approve');
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('illegal_transition');
  });

  it('reports a Gitea outage as such and leaves the plan proposed for a retry', async () => {
    const { plan_id } = await propose(h);
    h.gitea.throwAlways.add('createBranch');

    const response = await act(plan_id, 'approve');
    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe('gitea_unavailable');
    expect(await planState(h, plan_id)).toBe('proposed');
  });

  it('returns 404 for a plan that does not exist', async () => {
    const response = await act('018f3a5c-0000-7000-8000-0000000000ff', 'approve');
    expect(response.statusCode).toBe(404);
  });
});

describe('reject', () => {
  it('moves the plan to rejected and cancels its tasks', async () => {
    const { plan_id } = await propose(h);
    const response = await act(plan_id, 'reject');

    expect(response.statusCode).toBe(200);
    expect(await planState(h, plan_id)).toBe('rejected');

    const { rows } = await h.pool.query<{ state: string }>(
      'SELECT DISTINCT state::text AS state FROM tasks WHERE plan_id = $1',
      [plan_id],
    );
    expect(rows.map((r) => r.state)).toEqual(['cancelled']);
  });

  it('refuses to reject an approved plan', async () => {
    const { plan_id } = await propose(h);
    await approve(h, plan_id);
    const response = await act(plan_id, 'reject');
    expect(response.statusCode).toBe(409);
  });
});

describe('cancel', () => {
  it('cancels a proposed plan without contacting a supervisor', async () => {
    const { plan_id } = await propose(h);
    const response = await act(plan_id, 'cancel');

    expect(response.statusCode).toBe(200);
    expect(await planState(h, plan_id)).toBe('cancelled');
    expect(h.supervisors.teardowns).toEqual([]);
  });

  it('cancels a queued plan', async () => {
    const { plan_id } = await propose(h);
    await approve(h, plan_id);
    await act(plan_id, 'cancel');
    expect(await planState(h, plan_id)).toBe('cancelled');
  });

  it('cancels a running plan, cascades to its tasks, and authorises teardown once', async () => {
    const running = await runningPlan(h);
    expect(await planState(h, running.planId)).toBe('running');

    const response = await act(running.planId, 'cancel');
    expect(response.statusCode).toBe(200);

    const { rows } = await h.pool.query<{ state: string }>(
      'SELECT DISTINCT state::text AS state FROM tasks WHERE plan_id = $1',
      [running.planId],
    );
    expect(rows.map((r) => r.state)).toEqual(['cancelled']);

    expect(h.supervisors.teardowns).toEqual([
      { agentId: running.supervisor.id, planId: running.planId, reason: 'cancelled' },
    ]);
  });

  it('destroys the per-plan token so it authorises nothing afterwards', async () => {
    const running = await runningPlan(h);
    await act(running.planId, 'cancel');

    expect(h.deps.tokens.get(running.planId)).toBeUndefined();

    const response = await h.app.inject({
      method: 'POST',
      url: `/plans/${running.planId}/tasks/${running.taskIds['a-write-tests']}/status`,
      headers: bearer(running.planToken),
      payload: { state: 'running' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('revokes the Gitea bot user', async () => {
    const running = await runningPlan(h);
    await act(running.planId, 'cancel');
    expect(h.gitea.revokeCalls).toHaveLength(1);
  });

  it('refuses to cancel a plan that already finished', async () => {
    const { plan_id } = await propose(h);
    await act(plan_id, 'reject');
    const response = await act(plan_id, 'cancel');
    expect(response.statusCode).toBe(409);
  });
});

describe('the gate is a database precondition, not a state label (G2, B2)', () => {
  it('never dispatches a plan whose approved_at is null, even if state says queued', async () => {
    await registerSupervisor(h);
    const { plan_id } = await propose(h);

    // Forge the state column directly, leaving approved_at null. This is the
    // shape of every bypass the gate has to survive.
    await h.pool.query("UPDATE plans SET state = 'queued' WHERE id = $1", [plan_id]);

    await tick(h.deps);

    expect(h.supervisors.planDispatches).toEqual([]);
    expect(await planState(h, plan_id)).toBe('queued');
  });

  it('dispatches the same plan once approved_at is set', async () => {
    await registerSupervisor(h);
    const { plan_id } = await propose(h);
    await approve(h, plan_id);

    await tick(h.deps);

    expect(h.supervisors.planDispatches).toHaveLength(1);
    expect(await planState(h, plan_id)).toBe('running');
  });
});

describe('operator routes reject machine credentials', () => {
  it('refuses a supervisor token on an operator route', async () => {
    const supervisor = await registerSupervisor(h);
    const response = await h.app.inject({
      method: 'GET',
      url: '/plans',
      headers: bearer(supervisor.token),
    });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a plan token on an operator route', async () => {
    const running = await runningPlan(h);
    const response = await h.app.inject({
      method: 'POST',
      url: `/plans/${running.planId}/cancel`,
      headers: bearer(running.planToken),
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('a plan carries its declared egress through the gate unchanged', () => {
  it('hands the approved egress list to the supervisor at dispatch', async () => {
    const running = await runningPlan(h, {
      ...validPlan(),
      egress: ['pypi.org', '*.githubusercontent.com'],
    });

    expect(h.supervisors.planDispatches[0]?.request.egress).toEqual([
      'pypi.org',
      '*.githubusercontent.com',
    ]);
    expect(running.planId).toBeTruthy();
  });
});
