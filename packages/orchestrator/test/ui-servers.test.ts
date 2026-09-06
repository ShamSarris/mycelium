import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, operatorHeaders, type TestHarness } from './helpers/app.js';
import { registerSupervisor, runningPlan, validPlan } from './helpers/fixtures.js';

/**
 * The Servers page: the worker VMs, what each is running, and what the box
 * underneath it looks like.
 *
 * The telemetry arrives on the heartbeat (0003), which means two things this
 * page has to be honest about. A supervisor that predates the column reports
 * nothing, and rendering that as a row of zeros would be a lie. And a VM can
 * heartbeat without reporting, so the age of the metrics is a different number
 * from the age of the heartbeat and both are shown.
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

function page(url: string, headers = operatorHeaders()) {
  return h.app.inject({ method: 'GET', url, headers });
}

interface Envelope {
  as_of: string;
  attention: number;
  regions: Record<string, { v: string; html: string }>;
}

async function live(url = '/ui/live/servers'): Promise<Envelope> {
  const response = await page(url);
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as Envelope;
}

const METRICS = {
  uptime_sec: 93_600,
  cpu_count: 4,
  load_1: 2,
  load_5: 1.5,
  load_15: 1,
  cpu_saturation: 0.5,
  mem_total_mb: 8000,
  mem_available_mb: 2000,
  mem_used_pct: 75,
  disk_total_mb: 40_000,
  disk_free_mb: 30_000,
  disk_used_pct: 25,
  environments: 1,
  environment_capacity: 2,
  sandboxes: 3,
  version: '0.3.1',
};

async function report(
  supervisorId: string,
  metrics: Record<string, unknown> = METRICS,
  at: Date = h.clock.now(),
): Promise<void> {
  await h.pool.query('UPDATE agents SET last_metrics = $2, last_metrics_at = $3 WHERE id = $1', [
    supervisorId,
    JSON.stringify(metrics),
    at,
  ]);
}

describe('access', () => {
  it('is behind the same operator check as everything else under /ui', async () => {
    for (const url of ['/ui/servers', '/ui/live/servers']) {
      expect((await h.app.inject({ method: 'GET', url })).statusCode, url).toBe(401);
      expect(
        (await page(url, { 'tailscale-user-login': 'nobody@example.com' })).statusCode,
        url,
      ).toBe(403);
      expect((await page(url)).statusCode, url).toBe(200);
    }
  });
});

describe('the fleet', () => {
  it('says so plainly when no supervisor has registered', async () => {
    const { body } = await page('/ui/servers');

    expect(body).toContain('<!doctype html>');
    expect(body.toLowerCase()).toMatch(/no supervisor/);
  });

  it('shows each VM with its env, priority and whether it takes work', async () => {
    await registerSupervisor(h, { name: 'worker-a', priority: 50 });
    await registerSupervisor(h, { name: 'worker-b', enabled: false });

    const { body } = await page('/ui/servers');

    expect(body).toContain('worker-a');
    expect(body).toContain('worker-b');
    expect(body).toContain('50');
    // An operator who disabled a VM last week needs to see that from here,
    // not from the row silently never being picked.
    expect(body.toLowerCase()).toMatch(/disabled/);
  });

  it('calls a VM healthy or unhealthy by the same rule the dispatcher does', async () => {
    await registerSupervisor(h, { name: 'worker-fresh' });
    await registerSupervisor(h, { name: 'worker-silent', heartbeatAt: null });

    const { body } = await page('/ui/servers');

    expect(body).toContain('healthy');
    expect(body).toContain('unhealthy');
    expect(body).toContain(`${h.config.heartbeatHealthyMinutes}m`);
  });

  /**
   * An unhealthy VM takes no new dispatch, so the plans already on it are
   * stuck rather than merely slow. Naming them is the difference between "a VM
   * is down" and "these two plans are not going to finish".
   */
  it('names the plans stranded on an unhealthy VM', async () => {
    const running = await runningPlan(h, validPlan());
    await h.pool.query('UPDATE agents SET last_heartbeat_at = NULL WHERE id = $1', [
      running.supervisor.id,
    ]);

    const { body } = await page('/ui/servers');

    expect(body).toContain(`/ui/plans/${running.planId}`);
    expect(body.toLowerCase()).toMatch(/stuck/);
  });
});

describe('what the VM reports about itself', () => {
  it('renders the load, memory, disk, uptime and version it sent', async () => {
    const supervisor = await registerSupervisor(h, { name: 'worker-a' });
    await report(supervisor.id);

    const region = (await live()).regions.servers?.html ?? '';

    expect(region).toContain('0.3.1');
    expect(region).toMatch(/75/); // memory used
    expect(region).toMatch(/25/); // disk used
    expect(region).toContain('1 / 2'); // environments against capacity
    expect(region).not.toContain('undefined');
    expect(region).not.toContain('NaN');
  });

  /**
   * The plan's wording, and the reason it is worth a test: a supervisor that
   * has not been upgraded past 0003 reports nothing, and a row of zeros would
   * claim an idle machine rather than an unknown one.
   */
  it('says the telemetry is absent rather than rendering it as zero', async () => {
    await registerSupervisor(h, { name: 'worker-old' });

    const region = (await live()).regions.servers?.html ?? '';

    expect(region.toLowerCase()).toMatch(/no telemetry/);
    expect(region).not.toContain('0%');
  });

  /**
   * A VM whose collector is failing keeps heartbeating, so the heartbeat stays
   * young while the metrics age. Showing one number for both would report a
   * healthy machine reading its own stale data.
   */
  it('ages the metrics separately from the heartbeat', async () => {
    const supervisor = await registerSupervisor(h, { name: 'worker-a' });
    await report(supervisor.id, METRICS, new Date(h.clock.now().getTime() - 3_000_000));

    const region = (await live()).regions.servers?.html ?? '';

    expect(region).toContain('50m ago');
    expect(region).toContain('0s ago');
  });

  /**
   * The supervisor's ledger is in memory on the VM. The orchestrator has no
   * environments table to check it against, so the count is a claim, not a
   * fact, and the page says which it is.
   */
  it('labels the environment count as reported rather than verified', async () => {
    const supervisor = await registerSupervisor(h, { name: 'worker-a' });
    await report(supervisor.id);

    const region = (await live()).regions.servers?.html ?? '';

    expect(region.toLowerCase()).toMatch(/reported/);
  });

  it('renders a partial report without inventing the fields it did not get', async () => {
    const supervisor = await registerSupervisor(h, { name: 'worker-a' });
    await report(supervisor.id, { cpu_count: 4, load_1: 1 });

    const region = (await live()).regions.servers?.html ?? '';

    expect(region).not.toContain('undefined');
    expect(region).not.toContain('NaN');
    expect(region).not.toContain('null');
  });
});

describe('the fragment that refreshes it', () => {
  it('renders each region exactly as the document already has it', async () => {
    const supervisor = await registerSupervisor(h, { name: 'worker-a' });
    await report(supervisor.id);

    const { body } = await page('/ui/servers');
    const envelope = await live();

    for (const [id, region] of Object.entries(envelope.regions)) {
      expect(body, id).toContain(region.html);
      expect(body, id).toContain(`data-v="${region.v}"`);
    }
  });

  it('points the page at the endpoint that refreshes it', async () => {
    expect((await page('/ui/servers')).body).toContain('data-live="/ui/live/servers"');
  });

  it('does not change while nothing does', async () => {
    const supervisor = await registerSupervisor(h, { name: 'worker-a' });
    await report(supervisor.id);

    const first = await live();
    const second = await live();

    for (const id of Object.keys(first.regions)) {
      expect(second.regions[id]?.v, id).toBe(first.regions[id]?.v);
    }
  });
});

describe('what this page must never carry', () => {
  /**
   * Every agents row carries `token_hash`, and this is the page whose whole
   * job is to render agents rows. `viewAgent` is what makes that structurally
   * impossible; this is the assertion that it stayed that way.
   */
  it('renders no supervisor token or hash', async () => {
    const running = await runningPlan(h, validPlan());
    await report(running.supervisor.id);

    const bodies = [(await page('/ui/servers')).body, JSON.stringify(await live())];

    for (const body of bodies) {
      expect(body).not.toContain(running.supervisor.token);
      expect(body).not.toContain(running.planToken);
      expect(body).not.toMatch(/token_hash/);
    }
  });

  /**
   * The metrics are jsonb written by a semi-trusted peer. `parseHostMetrics`
   * builds from an allowlist so nothing else can get in — and if something
   * ever did, it would still have to survive the escaper.
   */
  it('escapes a version string the supervisor reported', async () => {
    const supervisor = await registerSupervisor(h, { name: 'worker-a' });
    await report(supervisor.id, { ...METRICS, version: '<script>alert(1)</script>' });

    const body = JSON.stringify(await live());

    expect(body).not.toContain('<script>alert(1)</script>');
  });
});
