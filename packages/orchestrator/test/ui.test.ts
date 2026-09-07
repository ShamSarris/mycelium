import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTransaction } from '../src/db/pool.js';
import { recordEvent } from '../src/services/events.js';
import { tick } from '../src/services/dispatcher.js';
import { buildTestApp, bearer, operatorHeaders, type TestHarness } from './helpers/app.js';
import { approve, propose, registerSupervisor, runningPlan } from './helpers/fixtures.js';
import { costPlan } from './helpers/cost-fixtures.js';

/**
 * The dashboard, rendered server-side and asserted through the same
 * `app.inject()` harness as everything else. No build step, no jsdom, and no
 * simulation of a browser standing in for one.
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

describe('access', () => {
  it('is behind the same operator check as everything else', async () => {
    const anonymous = await h.app.inject({ method: 'GET', url: '/ui' });
    expect(anonymous.statusCode).toBe(401);

    const stranger = await page('/ui', { 'tailscale-user-login': 'nobody@example.com' });
    expect(stranger.statusCode).toBe(403);
  });

  it('refuses a machine credential, which is not an operator', async () => {
    const supervisor = await registerSupervisor(h);
    const response = await page('/ui', bearer(supervisor.token));

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('sends the operator from / to the dashboard', async () => {
    const response = await page('/');

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/ui');
  });

  it('serves HTML', async () => {
    const response = await page('/ui');

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('<!doctype html>');
  });
});

describe('the overview', () => {
  it('puts a proposed plan under needs attention', async () => {
    await propose(h, costPlan());

    const body = (await page('/ui')).body;

    expect(body).toContain('Needs attention');
    expect(body).toContain(costPlan().goal as string);
  });

  it('says so plainly when nothing needs attention', async () => {
    const body = (await page('/ui')).body;

    // The empty state matters: this section is loud when it is not empty, so
    // it has to be unmistakably quiet when it is.
    expect(body).toMatch(/nothing (is )?waiting|nothing needs/i);
  });

  it('lists plans with their state and spend against the ceiling', async () => {
    const running = await runningPlan(h, costPlan());

    const body = (await page('/ui')).body;

    expect(body).toContain('running');
    expect(body).toContain(running.planId.slice(0, 8));
  });

  it('says why a plan is not running, rather than leaving it ambiguous', async () => {
    // A plan queued with attempts behind it is a different problem from one
    // nobody has approved, and today they look identical.
    const { plan_id } = await propose(h, costPlan());
    await approve(h, plan_id);
    await h.pool.query(
      `UPDATE plans SET provision_attempts = 3, next_provision_at = $2 WHERE id = $1`,
      [plan_id, new Date(h.clock.now().getTime() + 120_000)],
    );

    const body = (await page('/ui')).body;

    expect(body).toContain('3');
    expect(body).toMatch(/attempt|retry/i);
  });

  it('shows the workers and whether they are healthy', async () => {
    const supervisor = await registerSupervisor(h);

    const body = (await page('/ui')).body;

    expect(body).toContain(supervisor.name);
    expect(body).toMatch(/healthy|unhealthy/i);
  });

  it('marks a worker unhealthy once the heartbeat goes stale', async () => {
    await registerSupervisor(h);
    h.clock.advance(3 * 60_000);

    const body = (await page('/ui')).body;

    expect(body).toContain('unhealthy');
  });

  it('lists unacknowledged alerts', async () => {
    const { plan_id } = await propose(h, costPlan());
    await withTransaction(h.pool, (client) =>
      recordEvent(client, h.deps, {
        type: 'error',
        severity: 'error',
        planId: plan_id,
        payload: { stage: 'model_call', message: 'connection reset' },
      }),
    );

    const body = (await page('/ui')).body;

    expect(body).toContain('connection reset');
  });

  it('says when it last refreshed, so a stale view looks stale', async () => {
    // Browsers throttle timers in background tabs, so the page cannot promise
    // freshness — only that it will say how fresh it is.
    expect((await page('/ui')).body).toMatch(/refreshed|as of/i);
  });
});

describe('a plan', () => {
  it('shows everything the approval gate covers', async () => {
    const { plan_id } = await propose(h, {
      ...costPlan(),
      non_goals: ['Do not touch the deploy pipeline.'],
      egress: ['pypi.org'],
      max_cost_microusd: 4_200_000, // $4.20
    });

    const body = (await page(`/ui/plans/${plan_id}`)).body;

    expect(body).toContain((costPlan().assumptions as string[])[0] as string);
    expect(body).toContain('Do not touch the deploy pipeline.');
    expect(body).toContain('pypi.org');
    expect(body).toContain('$4.20');
    expect(body).toMatch(/240|TTL/i);
  });

  it('lists the tasks with their state', async () => {
    const running = await runningPlan(h, costPlan());

    const body = (await page(`/ui/plans/${running.planId}`)).body;

    for (const task of costPlan().tasks as Array<{ id: string }>) {
      expect(body).toContain(task.id);
    }
  });

  it('shows the plan is recent events', async () => {
    const { plan_id } = await propose(h, costPlan());

    expect((await page(`/ui/plans/${plan_id}`)).body).toContain('plan.state_changed');
  });

  it('offers approve and reject on a proposed plan', async () => {
    const { plan_id } = await propose(h, costPlan());

    const body = (await page(`/ui/plans/${plan_id}`)).body;

    expect(body).toContain(`/ui/plans/${plan_id}/approve`);
    expect(body).toContain(`/ui/plans/${plan_id}/reject`);
  });

  it('offers cancel on a running plan, and not approve', async () => {
    const running = await runningPlan(h, costPlan());

    const body = (await page(`/ui/plans/${running.planId}`)).body;

    expect(body).toContain(`/ui/plans/${running.planId}/cancel`);
    expect(body).not.toContain(`/ui/plans/${running.planId}/approve`);
  });

  it('is a 404 for a plan that does not exist', async () => {
    const response = await page('/ui/plans/018f3a5c-0000-7000-8000-0000000000ff');

    expect(response.statusCode).toBe(404);
  });
});

describe('what the pages must never contain', () => {
  it('renders no token, hash, or credential anywhere', async () => {
    const running = await runningPlan(h, costPlan());
    await tick(h.deps);

    const bodies = [(await page('/ui')).body, (await page(`/ui/plans/${running.planId}`)).body];

    for (const body of bodies) {
      // The plan's own tokens are the ones at hand and the easiest to leak by
      // rendering a row wholesale.
      expect(body).not.toContain(running.planToken);
      expect(body).not.toContain('agent_token_hash');
      expect(body).not.toContain('gitea_bot_token');
      expect(body).not.toMatch(/token_hash/);
    }
  });

  it('escapes what came from a plan, so a goal cannot inject markup', async () => {
    const { plan_id } = await propose(h, {
      ...costPlan(),
      goal: 'Add <script>alert(1)</script> to the page.',
    });

    const body = (await page(`/ui/plans/${plan_id}`)).body;

    // Plans are authored by the operator, but they are also authored *with* an
    // LLM reading untrusted content, so this is not a theoretical concern.
    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).toContain('&lt;script&gt;');
  });
});

/**
 * The overview's plan table used to render every plan the 200-row cap
 * returned. These pin the pager, and — more importantly — pin the two
 * sections that read the *same* plan list for a different purpose: needs
 * attention and the worker placement counts. Paginating the query those two
 * share is exactly how a proposed plan silently stops being announced.
 */
describe('the overview plan pager', () => {
  /** A region of the rendered page, so an assertion cannot match markup another section owns. */
  function region(body: string, id: string): string {
    const start = body.indexOf(`data-region="${id}"`);
    expect(start, `no region ${id} on the page`).toBeGreaterThan(-1);
    return body.slice(start, body.indexOf('</section>', start));
  }

  /**
   * Newest last: `proposed_at DESC` puts the final one at the top of page 1.
   * The goal, not the id, is what identifies a plan in these assertions — a
   * UUIDv7's leading hex is its millisecond timestamp, so the eight-character
   * prefix the table renders is shared by every plan proposed in the same
   * few minutes and distinguishes none of them.
   */
  async function proposePlans(count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      await propose(h, costPlan({ goal: `plan number ${i}` }));
      h.clock.advance(60_000);
    }
  }

  it('shows five plans on the first page and no more', async () => {
    await proposePlans(6);

    const plans = region((await page('/ui')).body, 'plans');

    for (let i = 1; i < 6; i += 1) expect(plans).toContain(`plan number ${i}`);
    expect(plans).not.toContain('plan number 0');
  });

  it('shows the older plans on the second page, and only those', async () => {
    await proposePlans(6);

    const plans = region((await page('/ui?page=2')).body, 'plans');

    expect(plans).toContain('plan number 0');
    for (let i = 1; i < 6; i += 1) expect(plans).not.toContain(`plan number ${i}`);
  });

  it('says which page it is on and how many there are', async () => {
    await proposePlans(6);

    const plans = region((await page('/ui')).body, 'plans');

    expect(plans).toMatch(/page 1 of 2/i);
  });

  it('offers next but not prev on the first page', async () => {
    await proposePlans(6);

    const plans = region((await page('/ui')).body, 'plans');

    expect(plans).toContain('/ui?page=2');
    expect(plans).not.toContain('/ui?page=0');
  });

  it('offers prev but not next on the last page', async () => {
    await proposePlans(6);

    const plans = region((await page('/ui?page=2')).body, 'plans');

    expect(plans).toContain('/ui?page=1');
    expect(plans).not.toContain('/ui?page=3');
  });

  it('renders no pager at all when everything fits on one page', async () => {
    await proposePlans(3);

    const plans = region((await page('/ui')).body, 'plans');

    expect(plans).not.toMatch(/page 1 of/i);
  });

  /**
   * The section that exists to stop a decision being missed must not be
   * paginated by a table that has nothing to do with it.
   */
  it('keeps every proposed plan under needs attention, whatever page the table is on', async () => {
    await proposePlans(6);

    const attention = region((await page('/ui?page=2')).body, 'attention');

    for (let i = 0; i < 6; i += 1) expect(attention).toContain(`plan number ${i}`);
  });

  it('counts a worker placement from every page, not just the visible one', async () => {
    await proposePlans(6);
    // Registered after the plans, not before: proposing advances the clock
    // six minutes, which is long enough to make an earlier heartbeat stale
    // and render this row as "stuck here" rather than "placed".
    const supervisor = await registerSupervisor(h);
    await h.pool.query(`UPDATE plans SET agent_id = $1, state = 'running'`, [supervisor.id]);

    const workers = region((await page('/ui')).body, 'workers');

    expect(workers).toContain('6 placed');
  });

  it('carries the page into the live url, so a poll does not snap back to the first', async () => {
    await proposePlans(6);

    const body = (await page('/ui?page=2')).body;

    expect(body).toContain('data-live="/ui/live/overview?page=2"');
  });

  it('serves the same page through the fragment route', async () => {
    await proposePlans(6);

    const fragment = await page('/ui/live/overview?page=2');
    // The fragment carries every region, and needs-attention names all six
    // plans — so this has to read the plans region, not the whole body.
    const plans = JSON.parse(fragment.body).regions.plans.html as string;

    expect(fragment.statusCode).toBe(200);
    expect(plans).toContain('plan number 0');
    expect(plans).not.toContain('plan number 5');
  });

  it('falls back to the first page for a page that is not a number', async () => {
    await proposePlans(6);

    const plans = region((await page('/ui?page=banana')).body, 'plans');

    expect(plans).toContain('plan number 5');
    expect(plans).toMatch(/page 1 of 2/i);
  });

  it('clamps a page past the end to the last one, rather than rendering nothing', async () => {
    await proposePlans(6);

    const plans = region((await page('/ui?page=99')).body, 'plans');

    expect(plans).toContain('plan number 0');
    expect(plans).toMatch(/page 2 of 2/i);
  });
});
