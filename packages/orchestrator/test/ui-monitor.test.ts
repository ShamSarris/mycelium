import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, operatorHeaders, type TestHarness } from './helpers/app.js';
import { propose, runningPlan } from './helpers/fixtures.js';
import { costPlan } from './helpers/cost-fixtures.js';

/**
 * The Monitor page: what has run, what failed, and where the tokens went.
 *
 * Every number here is an aggregate over a window, and the window is the part
 * that has to be defended. An unparseable `days` is a stale bookmark or a
 * fat-fingered URL, not an attack, so it falls back rather than 400ing; and
 * every figure has to say what it is a window *over*, because "spend last
 * week" means nothing until you know it is keyed on when a task finished.
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

async function live(url = '/ui/live/monitor'): Promise<Envelope> {
  const response = await page(url);
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as Envelope;
}

function allRegions(envelope: Envelope): string {
  return Object.values(envelope.regions)
    .map((region) => region.html)
    .join('\n');
}

/** Days back from the harness clock, as the database sees it. */
function daysAgo(days: number): Date {
  return new Date(h.clock.now().getTime() - days * 86_400_000);
}

async function finishTasks(planId: string, costMicrousd: number, at: Date): Promise<void> {
  await h.pool.query(
    `UPDATE tasks
        SET state = 'done', cost_spent_microusd = $2, started_at = $3, finished_at = $4,
            updated_at = $4
      WHERE plan_id = $1`,
    [planId, costMicrousd, new Date(at.getTime() - 120_000), at],
  );
}

async function recordEvent(type: string, severity: string, at: Date): Promise<void> {
  await h.pool.query(
    `INSERT INTO events (event_id, ts, received_at, source, stream_id, seq, type, severity, payload)
     VALUES ($1, $2, $2, 'orchestrator', 'test', nextval('orchestrator_seq'), $3, $4, '{}'::jsonb)`,
    [crypto.randomUUID(), at, type, severity],
  );
}

describe('access', () => {
  it('is behind the same operator check as everything else under /ui', async () => {
    for (const url of ['/ui/monitor', '/ui/live/monitor']) {
      expect((await h.app.inject({ method: 'GET', url })).statusCode, url).toBe(401);
      expect(
        (await page(url, { 'tailscale-user-login': 'nobody@example.com' })).statusCode,
        url,
      ).toBe(403);
      expect((await page(url)).statusCode, url).toBe(200);
    }
  });
});

describe('the window', () => {
  it('offers one day, one week and one month, and says which it is showing', async () => {
    const { body } = await page('/ui/monitor?days=1');

    expect(body).toContain('/ui/monitor?days=1');
    expect(body).toContain('/ui/monitor?days=7');
    expect(body).toContain('/ui/monitor?days=30');
    expect(body).toContain('data-live="/ui/live/monitor?days=1"');
  });

  /**
   * A stale bookmark or a hand-edited URL is not worth an error page — the
   * operator wanted the monitor, and the monitor has a sane default.
   */
  it('falls back to a week rather than refusing an unusable value', async () => {
    for (const query of ['?days=banana', '?days=99', '?days=-3', '?days=', '']) {
      const response = await page(`/ui/monitor${query}`);

      expect(response.statusCode, query).toBe(200);
      expect(response.body, query).toContain('data-live="/ui/live/monitor?days=7"');
    }
  });

  it('carries the same window into the fragment it polls', async () => {
    const envelope = await live('/ui/live/monitor?days=30');
    expect(allRegions(envelope)).toContain('/ui/monitor?days=30');
  });
});

describe('an empty database', () => {
  /**
   * Every figure on this page is an aggregate, and an aggregate over nothing
   * is where NaN and Infinity come from. The empty case is the one an operator
   * meets first, on the day they open the dashboard before anything has run.
   */
  it('renders every section without a NaN, an undefined or an Infinity', async () => {
    const rendered = allRegions(await live());

    expect(rendered).not.toContain('NaN');
    expect(rendered).not.toContain('undefined');
    expect(rendered).not.toContain('Infinity');
    expect(rendered).not.toContain('null');
  });
});

describe('what ran', () => {
  it('counts the plans proposed in the window by state', async () => {
    await propose(h, costPlan());
    await propose(h, { ...costPlan(), goal: 'A second plan.' });

    const rendered = allRegions(await live());

    expect(rendered).toMatch(/proposed/);
    expect(rendered).toContain('2');
  });

  it('sums what tasks spent, and keys the sum on when they finished', async () => {
    const running = await runningPlan(h, costPlan());
    await finishTasks(running.planId, 1_200_000, daysAgo(1));

    const rendered = allRegions(await live());

    // Two tasks at $1.20 each. Labelled by its key, because "spend last week"
    // means nothing until you know which timestamp it is a window over.
    expect(rendered).toContain('$2.40');
    expect(rendered.toLowerCase()).toContain('by task finish');
  });

  it('leaves out work that finished before the window', async () => {
    const running = await runningPlan(h, costPlan());
    // Comfortably past 2^31 microusd (~$2,147.48) once both tasks are summed,
    // so this also exercises the ::bigint cast rather than only formatCost.
    await finishTasks(running.planId, 5_000_000_000, daysAgo(20));

    const inWeek = allRegions(await live('/ui/live/monitor?days=7'));
    const inMonth = allRegions(await live('/ui/live/monitor?days=30'));

    expect(inWeek).not.toContain('$10,000');
    expect(inMonth).toContain('$10,000');
  });

  it('reports how long tasks took, as a median and a tail', async () => {
    const running = await runningPlan(h, costPlan());
    await finishTasks(running.planId, 100_000, daysAgo(1));

    const rendered = allRegions(await live());

    expect(rendered.toLowerCase()).toContain('p50');
    expect(rendered.toLowerCase()).toContain('p95');
  });
});

describe('what broke', () => {
  it('names each failed plan with the reason it stopped', async () => {
    const { plan_id } = await propose(h, costPlan());
    await h.pool.query(
      `UPDATE plans SET state = 'failed', terminal_reason = 'task_failed:transport_error',
                        updated_at = $2 WHERE id = $1`,
      [plan_id, daysAgo(1)],
    );

    const rendered = allRegions(await live());

    expect(rendered).toContain('task_failed:transport_error');
    expect(rendered).toContain(`/ui/plans/${plan_id}`);
  });

  it('counts the warn and error events by type, so a repeat is visible as one', async () => {
    await recordEvent('error', 'error', daysAgo(1));
    await recordEvent('error', 'error', daysAgo(2));
    await recordEvent('limit.exceeded', 'warn', daysAgo(1));
    await recordEvent('task.state_changed', 'info', daysAgo(1));

    const rendered = allRegions(await live());

    expect(rendered).toContain('limit.exceeded');
    // The info event is not a failure and must not be counted as one.
    expect(rendered).not.toContain('task.state_changed');
  });
});

describe('the fragment that refreshes it', () => {
  it('renders each region exactly as the document already has it', async () => {
    const running = await runningPlan(h, costPlan());
    await finishTasks(running.planId, 300, daysAgo(1));

    const { body } = await page('/ui/monitor');
    const envelope = await live();

    for (const [id, region] of Object.entries(envelope.regions)) {
      expect(body, id).toContain(region.html);
      expect(body, id).toContain(`data-v="${region.v}"`);
    }
  });

  it('does not change while nothing does', async () => {
    await propose(h, costPlan());

    const first = await live();
    const second = await live();

    for (const id of Object.keys(first.regions)) {
      expect(second.regions[id]?.v, id).toBe(first.regions[id]?.v);
    }
  });
});

describe('what this page must never carry', () => {
  it('renders no token, hash or bot credential', async () => {
    const running = await runningPlan(h, costPlan());
    await finishTasks(running.planId, 300, daysAgo(1));

    const bodies = [(await page('/ui/monitor')).body, JSON.stringify(await live())];

    for (const body of bodies) {
      expect(body).not.toContain(running.planToken);
      expect(body).not.toContain(running.supervisor.token);
      expect(body).not.toContain('agent_token_hash');
      expect(body).not.toMatch(/token_hash/);
    }
  });

  it('escapes a plan goal in a failure row', async () => {
    const { plan_id } = await propose(h, { ...costPlan(), goal: 'Add <script>alert(1)</script>' });
    await h.pool.query(
      `UPDATE plans SET state = 'failed', terminal_reason = 'nope', updated_at = $2 WHERE id = $1`,
      [plan_id, daysAgo(1)],
    );

    const rendered = allRegions(await live());

    expect(rendered).not.toContain('<script>alert(1)</script>');
    expect(rendered).toContain('&lt;script&gt;');
  });
});
