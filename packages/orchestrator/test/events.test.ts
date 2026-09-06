import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../src/db/uuid.js';
import { buildTestApp, bearer, operatorHeaders, type TestHarness } from './helpers/app.js';
import {
  registerSupervisor,
  runningPlan,
  singleTaskPlan,
  type RegisteredSupervisor,
  type RunningPlan,
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

let seq = 0;

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  seq += 1;
  return {
    event_id: newId(),
    ts: '2026-09-02T12:00:00.000Z',
    source: 'supervisor',
    stream_id: 'supervisor-1',
    seq,
    type: 'sandbox.launched',
    ...overrides,
  };
}

function ingest(token: string, body: unknown) {
  return h.app.inject({
    method: 'POST',
    url: '/events',
    headers: bearer(token),
    payload: body as never,
  });
}

describe('ingest from a supervisor', () => {
  let supervisor: RegisteredSupervisor;

  beforeEach(async () => {
    supervisor = await registerSupervisor(h);
    seq = 0;
  });

  it('inserts a batch and reports the count', async () => {
    const response = await ingest(supervisor.token, [envelope(), envelope()]);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ inserted: 2, duplicates: 0 });
  });

  it('drops a replayed event rather than duplicating it', async () => {
    const event = envelope();
    await ingest(supervisor.token, [event]);
    const second = await ingest(supervisor.token, [event]);

    expect(second.json()).toEqual({ inserted: 0, duplicates: 1 });

    const { rows } = await h.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM events');
    expect(rows[0]?.n).toBe(1);
  });

  it('rejects a stream reusing a seq for a different event', async () => {
    await ingest(supervisor.token, [envelope({ stream_id: 's', seq: 5 })]);
    const response = await ingest(supervisor.token, [envelope({ stream_id: 's', seq: 5 })]);

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('seq_reused');
  });

  it('records which supervisor delivered the batch', async () => {
    await ingest(supervisor.token, [envelope()]);
    const { rows } = await h.pool.query<{ ingested_by: string }>(
      "SELECT ingested_by FROM events WHERE source = 'supervisor'",
    );
    expect(rows[0]?.ingested_by).toBe(supervisor.id);
  });

  it('refuses an envelope claiming to come from the orchestrator', async () => {
    const response = await ingest(supervisor.token, [envelope({ source: 'orchestrator' })]);
    expect(response.statusCode).toBe(403);
  });

  it('rejects a payload key that looks like a secret', async () => {
    const response = await ingest(supervisor.token, [
      envelope({ payload: { api_key: 'sk-live-oops' } }),
    ]);

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('secret_in_payload');
  });

  it('rejects other secret-shaped keys too', async () => {
    for (const key of ['token', 'bot_token', 'password', 'client_secret', 'apiKey']) {
      const response = await ingest(supervisor.token, [envelope({ payload: { [key]: 'x' } })]);
      expect(response.statusCode, key).toBe(400);
    }
  });

  // The other half of the same rule: a key that counts tokens is not a key that
  // carries one. This payload is agent.model_call's, verbatim from the worker's
  // emitter; the old substring guard refused five of its eight keys, so no
  // model-call event ever reached this table.
  it('accepts a payload whose keys count tokens rather than carrying one', async () => {
    const response = await ingest(supervisor.token, [
      envelope({
        type: 'agent.model_call',
        payload: {
          model: 'claude-sonnet-5',
          stop_reason: 'end_turn',
          tokens_total: 12_400,
          tokens_this_attempt: 3_100,
          input_tokens: 2_800,
          output_tokens: 300,
          cache_read_tokens: 9_000,
          usage_source: 'provider',
        },
      }),
    ]);

    expect(response.statusCode).toBe(200);
    const { rows } = await h.pool.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM events WHERE type = 'agent.model_call'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({ tokens_total: 12_400, cache_read_tokens: 9_000 });
  });

  it('fails the whole batch when one envelope is invalid, so a spool never half-drains', async () => {
    const response = await ingest(supervisor.token, [
      envelope(),
      envelope({ type: 'agent.telepathy' }),
      envelope(),
    ]);

    expect(response.statusCode).toBe(400);
    const { rows } = await h.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM events');
    expect(rows[0]?.n).toBe(0);
  });

  it('rejects a batch over the cap', async () => {
    const batch = Array.from({ length: 501 }, () => envelope());
    const response = await ingest(supervisor.token, batch);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('batch_too_large');
  });

  it('rejects a body that is not an array', async () => {
    const response = await ingest(supervisor.token, envelope());
    expect(response.statusCode).toBe(400);
  });

  it('accepts an empty batch', async () => {
    const response = await ingest(supervisor.token, []);
    expect(response.json()).toEqual({ inserted: 0, duplicates: 0 });
  });

  it('refuses an unknown token', async () => {
    const response = await ingest('not-a-token', [envelope()]);
    expect(response.statusCode).toBe(401);
  });

  it('refuses a disabled supervisor', async () => {
    await h.pool.query('UPDATE agents SET enabled = false WHERE id = $1', [supervisor.id]);
    const response = await ingest(supervisor.token, [envelope()]);
    expect(response.statusCode).toBe(403);
  });
});

describe('ingest from a plan agent', () => {
  let running: RunningPlan;

  beforeEach(async () => {
    running = await runningPlan(h, singleTaskPlan());
    seq = 100;
  });

  it('accepts events for its own plan', async () => {
    const response = await ingest(running.planToken, [
      envelope({ source: 'agent', stream_id: 'agent-1', plan_id: running.planId }),
    ]);
    expect(response.statusCode).toBe(200);
  });

  it('refuses events naming another plan', async () => {
    const other = await runningPlan(h, { ...singleTaskPlan(), project: { name: 'other' } });
    const response = await ingest(running.planToken, [
      envelope({ source: 'agent', stream_id: 'agent-1', plan_id: other.planId }),
    ]);
    expect(response.statusCode).toBe(403);
  });

  it('refuses events with no plan id at all', async () => {
    const response = await ingest(running.planToken, [
      envelope({ source: 'agent', stream_id: 'agent-1' }),
    ]);
    expect(response.statusCode).toBe(403);
  });

  it('attributes the events to the plan supervisor for reconciliation', async () => {
    await ingest(running.planToken, [
      envelope({ source: 'agent', stream_id: 'agent-1', plan_id: running.planId }),
    ]);
    const { rows } = await h.pool.query<{ ingested_by: string }>(
      "SELECT ingested_by FROM events WHERE source = 'agent'",
    );
    expect(rows[0]?.ingested_by).toBe(running.supervisor.id);
  });
});

// Baseline sections 4 and 10: the agent emits to its supervisor, which spools
// to disk and replays in order. That is the only path that survives an
// orchestrator outage, so a supervisor token has to be allowed to carry
// agent-sourced envelopes for the plans it is running.
describe('a supervisor relaying its agent events', () => {
  let running: RunningPlan;

  beforeEach(async () => {
    running = await runningPlan(h, singleTaskPlan());
    seq = 200;
  });

  /**
   * First-fit selection would otherwise put a second plan on the same
   * supervisor, so disable this one while the other plan is provisioned.
   */
  async function planOnAnotherSupervisor(): Promise<RunningPlan> {
    await h.pool.query('UPDATE agents SET enabled = false WHERE id = $1', [running.supervisor.id]);
    const other = await runningPlan(h, { ...singleTaskPlan(), project: { name: 'other' } });
    await h.pool.query('UPDATE agents SET enabled = true WHERE id = $1', [running.supervisor.id]);
    expect(other.supervisor.id).not.toBe(running.supervisor.id);
    return other;
  }

  it('accepts agent events for a plan placed on it', async () => {
    const response = await ingest(running.supervisor.token, [
      envelope({ source: 'agent', stream_id: `agent:${running.planId}`, plan_id: running.planId }),
    ]);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ inserted: 1, duplicates: 0 });
  });

  it('records the relaying supervisor, not the agent, as the deliverer', async () => {
    await ingest(running.supervisor.token, [
      envelope({ source: 'agent', stream_id: `agent:${running.planId}`, plan_id: running.planId }),
    ]);
    const { rows } = await h.pool.query<{ ingested_by: string; source: string }>(
      "SELECT ingested_by, source FROM events WHERE source = 'agent'",
    );
    expect(rows[0]?.ingested_by).toBe(running.supervisor.id);
  });

  it('refuses agent events for a plan placed on another supervisor', async () => {
    const other = await planOnAnotherSupervisor();
    const response = await ingest(running.supervisor.token, [
      envelope({ source: 'agent', stream_id: `agent:${other.planId}`, plan_id: other.planId }),
    ]);
    expect(response.statusCode).toBe(403);
  });

  it('refuses agent events carrying no plan id', async () => {
    const response = await ingest(running.supervisor.token, [
      envelope({ source: 'agent', stream_id: 'agent-loose' }),
    ]);
    expect(response.statusCode).toBe(403);
  });

  it('accepts a mixed batch of its own and its agent events', async () => {
    const response = await ingest(running.supervisor.token, [
      envelope({ source: 'supervisor', stream_id: `supervisor:${running.supervisor.id}` }),
      envelope({ source: 'agent', stream_id: `agent:${running.planId}`, plan_id: running.planId }),
    ]);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ inserted: 2, duplicates: 0 });
  });

  it('rejects the whole batch when one relayed event names a foreign plan', async () => {
    const other = await planOnAnotherSupervisor();
    const response = await ingest(running.supervisor.token, [
      envelope({ source: 'agent', stream_id: `agent:${running.planId}`, plan_id: running.planId }),
      envelope({ source: 'agent', stream_id: `agent:${other.planId}`, plan_id: other.planId }),
    ]);

    expect(response.statusCode).toBe(403);
    const { rows } = await h.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM events');
    expect(rows[0]?.n).toBeGreaterThan(0);
    const { rows: agentRows } = await h.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM events WHERE source = 'agent'",
    );
    expect(agentRows[0]?.n).toBe(0);
  });

  it('records the new egress and environment types the supervisor emits', async () => {
    const response = await ingest(running.supervisor.token, [
      envelope({
        type: 'egress.denied',
        plan_id: running.planId,
        payload: { host: 'evil.example', port: 443, rule: null },
      }),
      envelope({
        type: 'environment.state_changed',
        plan_id: running.planId,
        payload: { from: 'running', to: 'torn_down', reason: 'completion' },
      }),
    ]);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ inserted: 2, duplicates: 0 });
  });
});

describe('GET /events', () => {
  let running: RunningPlan;

  beforeEach(async () => {
    running = await runningPlan(h, singleTaskPlan());
  });

  function read(query: string) {
    return h.app.inject({ method: 'GET', url: `/events?${query}`, headers: operatorHeaders() });
  }

  it('requires a plan_id filter', async () => {
    const response = await read('limit=10');
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('missing_filter');
  });

  it('returns the plan events in order', async () => {
    const response = await read(`plan_id=${running.planId}`);
    expect(response.statusCode).toBe(200);

    const types = response.json().events.map((e: { type: string }) => e.type);
    expect(types[0]).toBe('plan.state_changed');
    expect(types).toContain('task.dispatched');
  });

  it('pages with the cursor without repeating a row', async () => {
    const first = await read(`plan_id=${running.planId}&limit=2`);
    const firstIds = first.json().events.map((e: { event_id: string }) => e.event_id);
    expect(firstIds).toHaveLength(2);

    const second = await read(`plan_id=${running.planId}&limit=2&after=${first.json().next}`);
    const secondIds = second.json().events.map((e: { event_id: string }) => e.event_id);

    expect(secondIds.some((id: string) => firstIds.includes(id))).toBe(false);
  });

  it('rejects an unusable limit', async () => {
    const response = await read(`plan_id=${running.planId}&limit=0`);
    expect(response.statusCode).toBe(400);
  });

  it('caps the page size at 500', async () => {
    const response = await read(`plan_id=${running.planId}&limit=100000`);
    expect(response.statusCode).toBe(200);
    expect(response.json().events.length).toBeLessThanOrEqual(500);
  });

  it('refuses a caller who is not the operator', async () => {
    const response = await h.app.inject({
      method: 'GET',
      url: `/events?plan_id=${running.planId}`,
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('heartbeats', () => {
  it('records the heartbeat and writes an event', async () => {
    const supervisor = await registerSupervisor(h, { heartbeatAt: null });
    const response = await h.app.inject({
      method: 'POST',
      url: `/supervisors/${supervisor.id}/heartbeat`,
      headers: bearer(supervisor.token),
    });

    expect(response.statusCode).toBe(200);

    const { rows } = await h.pool.query<{ last_heartbeat_at: Date | null }>(
      'SELECT last_heartbeat_at FROM agents WHERE id = $1',
      [supervisor.id],
    );
    expect(rows[0]?.last_heartbeat_at).not.toBeNull();

    const { rows: events } = await h.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM events WHERE type = 'supervisor.heartbeat'",
    );
    expect(events[0]?.n).toBe(1);
  });

  it('refuses a heartbeat for a supervisor the token does not belong to', async () => {
    const a = await registerSupervisor(h, { name: 'w-a' });
    const b = await registerSupervisor(h, { name: 'w-b' });

    const response = await h.app.inject({
      method: 'POST',
      url: `/supervisors/${b.id}/heartbeat`,
      headers: bearer(a.token),
    });
    expect(response.statusCode).toBe(403);
  });

  it('reports health on GET /agents', async () => {
    const supervisor = await registerSupervisor(h);
    const response = await h.app.inject({
      method: 'GET',
      url: '/agents',
      headers: operatorHeaders(),
    });

    const agents = response.json().agents as Array<{ id: string; healthy: boolean }>;
    expect(agents.find((a) => a.id === supervisor.id)?.healthy).toBe(true);
  });

  it('reports a silent supervisor as unhealthy', async () => {
    await registerSupervisor(h, { heartbeatAt: new Date(h.clock.now().getTime() - 200_000) });
    const response = await h.app.inject({
      method: 'GET',
      url: '/agents',
      headers: operatorHeaders(),
    });

    const agents = response.json().agents as Array<{ healthy: boolean }>;
    expect(agents[0]?.healthy).toBe(false);
  });
});

describe('restart reconciliation', () => {
  it('lists the non-terminal plans placed on this supervisor', async () => {
    const running = await runningPlan(h, singleTaskPlan());

    const response = await h.app.inject({
      method: 'GET',
      url: `/supervisors/${running.supervisor.id}/assignments`,
      headers: bearer(running.supervisor.token),
    });

    expect(response.statusCode).toBe(200);
    const plans = response.json().plans as Array<{ plan_id: string; state: string }>;
    expect(plans).toHaveLength(1);
    expect(plans[0]?.plan_id).toBe(running.planId);
    expect(plans[0]?.state).toBe('running');
  });

  it('returns the per-stream high-water marks it delivered', async () => {
    const running = await runningPlan(h, singleTaskPlan());
    seq = 0;
    await ingest(running.supervisor.token, [
      envelope({ stream_id: 'sup-a', seq: 1 }),
      envelope({ stream_id: 'sup-a', seq: 2 }),
      envelope({ stream_id: 'sup-b', seq: 9 }),
    ]);

    const response = await h.app.inject({
      method: 'GET',
      url: `/supervisors/${running.supervisor.id}/assignments`,
      headers: bearer(running.supervisor.token),
    });

    expect(response.json().high_water_marks).toEqual([
      { stream_id: 'sup-a', seq: 2 },
      { stream_id: 'sup-b', seq: 9 },
    ]);
  });

  it('omits a plan that has finished', async () => {
    const running = await runningPlan(h, singleTaskPlan());
    await h.pool.query("UPDATE plans SET state = 'done' WHERE id = $1", [running.planId]);

    const response = await h.app.inject({
      method: 'GET',
      url: `/supervisors/${running.supervisor.id}/assignments`,
      headers: bearer(running.supervisor.token),
    });
    expect(response.json().plans).toEqual([]);
  });

  it('refuses to answer for another supervisor', async () => {
    const a = await registerSupervisor(h, { name: 'w-a' });
    const b = await registerSupervisor(h, { name: 'w-b' });

    const response = await h.app.inject({
      method: 'GET',
      url: `/supervisors/${b.id}/assignments`,
      headers: bearer(a.token),
    });
    expect(response.statusCode).toBe(403);
  });
});
