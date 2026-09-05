import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tick } from '../src/services/dispatcher.js';
import { buildTestApp, type TestHarness } from './helpers/app.js';
import {
  approve,
  planState,
  propose,
  registerSupervisor,
  singleTaskPlan,
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

async function queuedPlan(plan: Record<string, unknown> = validPlan()): Promise<string> {
  const { plan_id } = await propose(h, plan);
  await approve(h, plan_id);
  return plan_id;
}

async function planRow(planId: string) {
  const { rows } = await h.pool.query<{
    state: string;
    agent_id: string | null;
    provision_attempts: number;
    next_provision_at: Date | null;
    ttl_expires_at: Date | null;
    running_at: Date | null;
  }>(
    `SELECT state::text AS state, agent_id, provision_attempts, next_provision_at,
            ttl_expires_at, running_at
       FROM plans WHERE id = $1`,
    [planId],
  );
  return rows[0];
}

describe('selecting a supervisor', () => {
  it('dispatches the plan to the one healthy candidate and marks it running', async () => {
    const supervisor = await registerSupervisor(h);
    const planId = await queuedPlan();

    await tick(h.deps);

    expect(h.supervisors.planDispatches).toHaveLength(1);
    expect(h.supervisors.planDispatches[0]?.agentId).toBe(supervisor.id);

    const row = await planRow(planId);
    expect(row?.state).toBe('running');
    expect(row?.agent_id).toBe(supervisor.id);
  });

  it('sends the full plan dispatch, including the branch and the per-plan token', async () => {
    await registerSupervisor(h);
    const planId = await queuedPlan();
    await tick(h.deps);

    const request = h.supervisors.planDispatches[0]?.request;
    expect(request?.plan_id).toBe(planId);
    expect(request?.project.name).toBe('demo');
    expect(request?.gitea.branch).toBe(`plan/${planId}`);
    expect(request?.gitea.bot_token).toBe(h.deps.tokens.get(planId)?.giteaBotToken);
    expect(request?.orchestrator_token).toBe(h.deps.tokens.get(planId)?.orchestratorToken);
    expect(request?.max_concurrent_agents).toBe(2);
    expect(request?.env_ttl_min).toBe(240);
  });

  it('sets the environment TTL from the plan', async () => {
    await registerSupervisor(h);
    const planId = await queuedPlan({ ...validPlan(), env_ttl_min: 30 });
    await tick(h.deps);

    const row = await planRow(planId);
    const expected = new Date(h.clock.now().getTime() + 30 * 60_000);
    expect(row?.ttl_expires_at?.toISOString()).toBe(expected.toISOString());
  });

  it('marks the plan root tasks ready once the supervisor accepts', async () => {
    await registerSupervisor(h);
    const planId = await queuedPlan();
    await tick(h.deps);

    const { rows } = await h.pool.query<{ local_id: string; state: string }>(
      'SELECT local_id, state::text AS state FROM tasks WHERE plan_id = $1 ORDER BY local_id',
      [planId],
    );
    // The root task is dispatched within the same tick; the dependant waits.
    expect(rows[0]?.state).toBe('dispatched');
    expect(rows[1]?.state).toBe('pending');
  });

  it('tries the lower priority number first', async () => {
    const second = await registerSupervisor(h, { priority: 200, name: 'w-high' });
    const first = await registerSupervisor(h, { priority: 10, name: 'w-low' });
    await queuedPlan();

    await tick(h.deps);

    expect(h.supervisors.planDispatches[0]?.agentId).toBe(first.id);
    expect(second.id).not.toBe(first.id);
  });

  it('breaks a priority tie on id, so the choice is replayable', async () => {
    const a = await registerSupervisor(h, { name: 'w-a' });
    const b = await registerSupervisor(h, { name: 'w-b' });
    await queuedPlan();

    await tick(h.deps);

    const expected = [a.id, b.id].sort()[0];
    expect(h.supervisors.planDispatches[0]?.agentId).toBe(expected);
  });

  it('moves to the next candidate when the first is at capacity', async () => {
    const a = await registerSupervisor(h, { name: 'w-a', priority: 1 });
    const b = await registerSupervisor(h, { name: 'w-b', priority: 2 });
    h.supervisors.planResponses.set(a.id, {
      accepted: false,
      code: 'capacity_exceeded',
      retryable: true,
    });
    const planId = await queuedPlan();

    await tick(h.deps);

    expect(h.supervisors.planDispatches.map((d) => d.agentId)).toEqual([a.id, b.id]);
    expect((await planRow(planId))?.agent_id).toBe(b.id);
  });

  it('skips a candidate registered for another environment', async () => {
    await registerSupervisor(h, { env: 'prod' });
    const planId = await queuedPlan();

    await tick(h.deps);

    expect(h.supervisors.planDispatches).toEqual([]);
    expect(await planState(h, planId)).toBe('queued');
  });

  it('skips a disabled candidate', async () => {
    await registerSupervisor(h, { enabled: false });
    const planId = await queuedPlan();

    await tick(h.deps);

    expect(h.supervisors.planDispatches).toEqual([]);
    expect(await planState(h, planId)).toBe('queued');
  });

  it('skips a candidate that has been silent for over two minutes', async () => {
    await registerSupervisor(h, { heartbeatAt: new Date(h.clock.now().getTime() - 121_000) });
    const planId = await queuedPlan();

    await tick(h.deps);

    expect(h.supervisors.planDispatches).toEqual([]);
    expect(await planState(h, planId)).toBe('queued');
  });

  it('skips a candidate that has never heartbeat', async () => {
    await registerSupervisor(h, { heartbeatAt: null });
    const planId = await queuedPlan();
    await tick(h.deps);
    expect(h.supervisors.planDispatches).toEqual([]);
  });
});

describe('when nothing accepts', () => {
  it('returns the plan to queued with a backoff and no supervisor attached', async () => {
    const a = await registerSupervisor(h);
    h.supervisors.planResponses.set(a.id, {
      accepted: false,
      code: 'capacity_exceeded',
      retryable: true,
    });
    const planId = await queuedPlan();

    await tick(h.deps);

    const row = await planRow(planId);
    expect(row?.state).toBe('queued');
    expect(row?.agent_id).toBeNull();
    expect(row?.provision_attempts).toBe(1);
    expect(row?.next_provision_at?.toISOString()).toBe(
      new Date(h.clock.now().getTime() + 5_000).toISOString(),
    );
  });

  it('does not retry before the backoff elapses', async () => {
    const a = await registerSupervisor(h);
    h.supervisors.planResponses.set(a.id, {
      accepted: false,
      code: 'capacity_exceeded',
      retryable: true,
    });
    await queuedPlan();

    await tick(h.deps);
    h.clock.advance(1_000);
    await tick(h.deps);

    expect(h.supervisors.planDispatches).toHaveLength(1);
  });

  it('retries once the backoff elapses, and doubles the next one', async () => {
    const a = await registerSupervisor(h);
    h.supervisors.planResponses.set(a.id, {
      accepted: false,
      code: 'capacity_exceeded',
      retryable: true,
    });
    const planId = await queuedPlan();

    await tick(h.deps);
    h.clock.advance(5_000);
    await tick(h.deps);

    expect(h.supervisors.planDispatches).toHaveLength(2);
    const row = await planRow(planId);
    expect(row?.provision_attempts).toBe(2);
    expect(row?.next_provision_at?.toISOString()).toBe(
      new Date(h.clock.now().getTime() + 10_000).toISOString(),
    );
  });

  it('keeps the plan queued when no supervisor is registered at all', async () => {
    const planId = await queuedPlan();
    await tick(h.deps);
    expect(await planState(h, planId)).toBe('queued');
  });
});

describe('a terminal rejection', () => {
  it('fails the plan and writes a manifest naming the reason', async () => {
    const a = await registerSupervisor(h);
    h.supervisors.planResponses.set(a.id, {
      accepted: false,
      code: 'validation_failed',
      retryable: false,
    });
    const planId = await queuedPlan();

    await tick(h.deps);

    const { rows } = await h.pool.query<{
      state: string;
      terminal_reason: string;
      manifest: { criteria: unknown[]; terminal_reason: string };
    }>('SELECT state::text AS state, terminal_reason, manifest FROM plans WHERE id = $1', [planId]);

    expect(rows[0]?.state).toBe('failed');
    expect(rows[0]?.terminal_reason).toBe('validation_failed');
    expect(rows[0]?.manifest.terminal_reason).toBe('validation_failed');
  });

  it('does not try any further candidate', async () => {
    const a = await registerSupervisor(h, { name: 'w-a', priority: 1 });
    await registerSupervisor(h, { name: 'w-b', priority: 2 });
    h.supervisors.planResponses.set(a.id, {
      accepted: false,
      code: 'validation_failed',
      retryable: false,
    });
    await queuedPlan();

    await tick(h.deps);

    expect(h.supervisors.planDispatches).toHaveLength(1);
  });

  it('cancels the plan tasks', async () => {
    const a = await registerSupervisor(h);
    h.supervisors.planResponses.set(a.id, {
      accepted: false,
      code: 'validation_failed',
      retryable: false,
    });
    const planId = await queuedPlan();

    await tick(h.deps);

    const { rows } = await h.pool.query<{ state: string }>(
      'SELECT DISTINCT state::text AS state FROM tasks WHERE plan_id = $1',
      [planId],
    );
    expect(rows.map((r) => r.state)).toEqual(['cancelled']);
  });
});

describe('placement is sticky (B12)', () => {
  it('never re-dispatches a plan that is already running', async () => {
    await registerSupervisor(h);
    await queuedPlan(singleTaskPlan());

    await tick(h.deps);
    await tick(h.deps);
    await tick(h.deps);

    expect(h.supervisors.planDispatches).toHaveLength(1);
  });

  it('keeps the same supervisor after a second, healthier one appears', async () => {
    const first = await registerSupervisor(h, { name: 'w-first', priority: 100 });
    const planId = await queuedPlan(singleTaskPlan());
    await tick(h.deps);

    await registerSupervisor(h, { name: 'w-better', priority: 1 });
    await tick(h.deps);

    expect((await planRow(planId))?.agent_id).toBe(first.id);
  });
});

describe('re-minting after an orchestrator restart', () => {
  it('mints a replacement token when the in-memory copy is gone', async () => {
    await registerSupervisor(h);
    const planId = await queuedPlan();

    const { rows: before } = await h.pool.query<{ agent_token_hash: string }>(
      'SELECT agent_token_hash FROM plans WHERE id = $1',
      [planId],
    );

    // A restart empties the cache. The plaintext is never at rest, so there is
    // nothing to recover and the dispatcher mints again.
    h.deps.tokens.clear();
    await tick(h.deps);

    const { rows: after } = await h.pool.query<{ agent_token_hash: string }>(
      'SELECT agent_token_hash FROM plans WHERE id = $1',
      [planId],
    );

    expect(after[0]?.agent_token_hash).not.toBe(before[0]?.agent_token_hash);
    expect(h.supervisors.planDispatches[0]?.request.orchestrator_token).toBe(
      h.deps.tokens.get(planId)?.orchestratorToken,
    );
    expect(await planState(h, planId)).toBe('running');
  });

  it('revokes the bot user it replaced', async () => {
    await registerSupervisor(h);
    const planId = await queuedPlan();

    h.deps.tokens.clear();
    await tick(h.deps);

    expect(h.gitea.createBotTokenCalls).toHaveLength(2);
    expect(h.gitea.revokeCalls).toEqual([`bot-user-${planId}-1`]);
  });
});
