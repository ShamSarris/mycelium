import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, bearer, type TestHarness } from './helpers/app.js';
import { registerSupervisor, type RegisteredSupervisor } from './helpers/fixtures.js';

/**
 * The heartbeat is what keeps a VM eligible for dispatch. Everything here is
 * ultimately one question: can adding telemetry to it ever cost a working VM
 * its place in the rotation? The answer has to be no for every shape a
 * supervisor might post, including the empty body every un-upgraded one sends.
 */

let h: TestHarness;
let supervisor: RegisteredSupervisor;

beforeAll(async () => {
  h = await buildTestApp();
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await h.reset();
  supervisor = await registerSupervisor(h, { heartbeatAt: null });
});

function heartbeat(body: unknown) {
  return h.app.inject({
    method: 'POST',
    url: `/supervisors/${supervisor.id}/heartbeat`,
    headers: bearer(supervisor.token),
    payload: body as never,
  });
}

async function stored(): Promise<{ last_metrics: unknown; last_metrics_at: Date | null }> {
  const { rows } = await h.pool.query<{ last_metrics: unknown; last_metrics_at: Date | null }>(
    'SELECT last_metrics, last_metrics_at FROM agents WHERE id = $1',
    [supervisor.id],
  );
  return rows[0]!;
}

const METRICS = {
  uptime_sec: 3600,
  cpu_count: 4,
  load_1: 0.5,
  cpu_saturation: 0.125,
  mem_total_mb: 8192,
  mem_available_mb: 6000,
  mem_used_pct: 26.8,
  environments: 1,
  environment_capacity: 2,
  sandboxes: 0,
  version: '0.1.0',
};

describe('heartbeat with metrics', () => {
  it('stores the report and stamps when it arrived', async () => {
    const response = await heartbeat({ metrics: METRICS });

    expect(response.statusCode).toBe(200);
    const row = await stored();
    expect(row.last_metrics).toEqual(METRICS);
    expect(row.last_metrics_at).toEqual(h.clock.now());
  });

  it('advances the heartbeat as it always did', async () => {
    await heartbeat({ metrics: METRICS });

    const { rows } = await h.pool.query<{ last_heartbeat_at: Date }>(
      'SELECT last_heartbeat_at FROM agents WHERE id = $1',
      [supervisor.id],
    );
    expect(rows[0]?.last_heartbeat_at).toEqual(h.clock.now());
  });

  it('replaces the previous report rather than merging into it', async () => {
    await heartbeat({ metrics: METRICS });
    await heartbeat({ metrics: { cpu_count: 8 } });

    expect(await stored().then((row) => row.last_metrics)).toEqual({ cpu_count: 8 });
  });

  it('keeps the metrics out of the event payload', async () => {
    // The heartbeat event fires every 30 seconds per VM into a table with no
    // retention policy. It stays {agent_id}.
    await heartbeat({ metrics: METRICS });

    const { rows } = await h.pool.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM events WHERE type = 'supervisor.heartbeat'",
    );
    expect(rows[0]?.payload).toEqual({ agent_id: supervisor.id });
  });
});

describe('a supervisor that reports nothing', () => {
  // Deploy order must not matter: an un-upgraded supervisor posts `{}` for as
  // long as it takes to roll the fleet, and it has to stay healthy throughout.
  it.each([
    ['an empty body', {}],
    ['a null metrics field', { metrics: null }],
    ['a metrics field that is junk', { metrics: 'lots' }],
    ['a metrics object of unknown keys', { metrics: { hostname: 'worker-1' } }],
  ])('%s still advances the heartbeat', async (_label, body) => {
    const response = await heartbeat(body);

    expect(response.statusCode).toBe(200);
    const { rows } = await h.pool.query<{ last_heartbeat_at: Date }>(
      'SELECT last_heartbeat_at FROM agents WHERE id = $1',
      [supervisor.id],
    );
    expect(rows[0]?.last_heartbeat_at).toEqual(h.clock.now());
  });

  it('leaves telemetry already stored in place rather than blanking it', async () => {
    await heartbeat({ metrics: METRICS });
    const stamped = (await stored()).last_metrics_at;

    h.clock.advance(60_000);
    await heartbeat({});

    const row = await stored();
    expect(row.last_metrics).toEqual(METRICS);
    // The age is what tells the operator this VM has gone quiet. If the stamp
    // moved with the heartbeat, alive-but-silent would look like fresh data.
    expect(row.last_metrics_at).toEqual(stamped);
  });

  it('has null in both columns before it ever reports', async () => {
    await heartbeat({});

    const row = await stored();
    expect(row.last_metrics).toBeNull();
    expect(row.last_metrics_at).toBeNull();
  });
});

describe('what a supervisor may write into the column', () => {
  it('drops keys the allowlist does not name', async () => {
    await heartbeat({
      metrics: { cpu_count: 2, hostname: 'worker-1', token: 'sk-live-nope' },
    });

    expect(await stored().then((row) => row.last_metrics)).toEqual({ cpu_count: 2 });
  });

  it('rejects nothing — a bad report is missing data, not a failed heartbeat', async () => {
    const response = await heartbeat({ metrics: { cpu_count: Number.MAX_VALUE, load_1: 'high' } });

    expect(response.statusCode).toBe(200);
  });
});
