import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, operatorHeaders, type TestHarness } from './helpers/app.js';
import { propose, runningPlan } from './helpers/fixtures.js';
import { costPlan } from './helpers/cost-fixtures.js';

/**
 * The Projects page: what exists, what each one has cost, and a way in.
 *
 * A project has no lifecycle column, no owner and no budget — it is `id`,
 * `name`, `gitea_repo`, `created_at` and nothing else. Everything else on this
 * page is derived from its plans, which is why the tests below are about
 * aggregation being right rather than about a projects feature existing.
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

async function live(url: string): Promise<Envelope> {
  const response = await page(url);
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as Envelope;
}

function planIn(project: string) {
  return { ...costPlan(), project: { name: project } };
}

/** The table row a project is on, so a count is asserted against the right project. */
function rowFor(body: string, name: string): string {
  const row = body.split('<tr').find((part) => part.includes(name));
  expect(row, `no row for ${name}`).toBeDefined();
  return row ?? '';
}

describe('access', () => {
  it('is behind the same operator check as everything else under /ui', async () => {
    const { project_id } = await propose(h, costPlan());

    for (const url of ['/ui/projects', `/ui/projects/${project_id}`, '/ui/live/projects']) {
      expect((await h.app.inject({ method: 'GET', url })).statusCode, url).toBe(401);
      expect(
        (await page(url, { 'tailscale-user-login': 'nobody@example.com' })).statusCode,
        url,
      ).toBe(403);
      expect((await page(url)).statusCode, url).toBe(200);
    }
  });
});

describe('the project list', () => {
  it('says so plainly when nothing has been proposed yet', async () => {
    const { body } = await page('/ui/projects');

    expect(body).toContain('<!doctype html>');
    expect(body.toLowerCase()).toMatch(/no projects/);
  });

  it('lists every project a plan has ever been proposed against', async () => {
    await propose(h, planIn('alpha'));
    await propose(h, planIn('beta'));

    const { body } = await page('/ui/projects');

    expect(body).toContain('alpha');
    expect(body).toContain('beta');
  });

  it('counts the plans and sums what they have spent', async () => {
    const { plan_id, project_id } = await propose(h, planIn('alpha'));
    await h.pool.query('UPDATE tasks SET cost_spent_microusd = 1_500_000 WHERE plan_id = $1', [
      plan_id,
    ]);

    const { body } = await page('/ui/projects');
    const row = rowFor(body, 'alpha');

    // Two tasks at $1.50 each: the sum is over tasks, because no plan row
    // carries a spend column and inventing one here would be a second source.
    expect(row).toContain('$3');
    expect(row).toContain(`/ui/projects/${project_id}`);
  });

  /**
   * `max(plans.updated_at)`, and labelled as exactly that. Calling it "last
   * activity" would imply it came from the event log, and an operator would
   * reasonably read a quiet column as "nothing has happened here".
   */
  it('names the recency column for the column it actually is', async () => {
    await propose(h, planIn('alpha'));
    const { body } = await page('/ui/projects');

    expect(body).toContain('last plan update');
  });

  /**
   * A repo is created lazily and can fail, so "no repo yet" is a real state
   * rather than an anomaly. Asserted against the region rather than the
   * document, because the client script legitimately contains both words.
   */
  it('shows a project with no repo without printing a null into the table', async () => {
    await propose(h, planIn('alpha'));
    await h.pool.query('UPDATE projects SET gitea_repo = NULL');

    const region = (await live('/ui/live/projects')).regions.projects?.html ?? '';

    expect(region).toContain('alpha');
    expect(region).not.toContain('undefined');
    expect(region).not.toContain('null');
    expect(region).not.toContain('NaN');
  });
});

describe('one project', () => {
  it('is a 404 when it does not exist, so the poll gives up rather than retrying', async () => {
    const missing = '018f3a5c-0000-7000-8000-0000000000ff';

    expect((await page(`/ui/projects/${missing}`)).statusCode).toBe(404);
    expect((await page(`/ui/live/projects/${missing}`)).statusCode).toBe(404);
  });

  it('shows its own plans and nobody else’s', async () => {
    const alpha = await propose(h, planIn('alpha'));
    await propose(h, { ...planIn('beta'), goal: 'A plan that belongs to beta.' });

    const { body } = await page(`/ui/projects/${alpha.project_id}`);

    expect(body).toContain(`/ui/plans/${alpha.plan_id}`);
    expect(body).not.toContain('A plan that belongs to beta.');
  });

  /**
   * The same renderer the overview uses, not a second table that looks like
   * it. Two of them would drift the first time a column was added to one.
   */
  it('renders its plans through the overview’s table, so the two cannot drift', async () => {
    const { plan_id, project_id } = await propose(h, planIn('alpha'));
    await h.pool.query('UPDATE tasks SET cost_spent_microusd = 700_000 WHERE plan_id = $1', [
      plan_id,
    ]);

    const overview = await live('/ui/live/overview');
    const project = await live(`/ui/live/projects/${project_id}`);

    expect(project.regions.plans?.html).toBe(overview.regions.plans?.html);
  });

  it('links back to the project list', async () => {
    const { project_id } = await propose(h, planIn('alpha'));
    const { body } = await page(`/ui/projects/${project_id}`);

    expect(body).toContain('href="/ui/projects"');
  });

  it('marks the projects tab as the one you are on, from both pages', async () => {
    const { project_id } = await propose(h, planIn('alpha'));

    for (const url of ['/ui/projects', `/ui/projects/${project_id}`]) {
      const nav = /<nav class="tabs">(.*?)<\/nav>/s.exec((await page(url)).body)?.[1] ?? '';
      expect(nav, url).toMatch(/href="\/ui\/projects"[^>]*aria-current="page"/);
    }
  });
});

describe('the fragments that refresh it', () => {
  it('renders each region exactly as the document already has it', async () => {
    const { project_id } = await propose(h, planIn('alpha'));

    for (const [pageUrl, liveUrl] of [
      ['/ui/projects', '/ui/live/projects'],
      [`/ui/projects/${project_id}`, `/ui/live/projects/${project_id}`],
    ] as const) {
      const { body } = await page(pageUrl);
      const envelope = await live(liveUrl);

      for (const [id, region] of Object.entries(envelope.regions)) {
        expect(body, `${pageUrl} ${id}`).toContain(region.html);
        expect(body, `${pageUrl} ${id}`).toContain(`data-v="${region.v}"`);
      }
    }
  });

  it('points each page at the endpoint that refreshes it', async () => {
    const { project_id } = await propose(h, planIn('alpha'));

    expect((await page('/ui/projects')).body).toContain('data-live="/ui/live/projects"');
    expect((await page(`/ui/projects/${project_id}`)).body).toContain(
      `data-live="/ui/live/projects/${project_id}"`,
    );
  });

  it('does not change while nothing does', async () => {
    await propose(h, planIn('alpha'));

    const first = await live('/ui/live/projects');
    const second = await live('/ui/live/projects');

    for (const id of Object.keys(first.regions)) {
      expect(second.regions[id]?.v, id).toBe(first.regions[id]?.v);
    }
  });
});

describe('what these pages must never carry', () => {
  it('renders no token, hash or bot credential', async () => {
    const running = await runningPlan(h, costPlan());
    const { rows } = await h.pool.query<{ project_id: string }>(
      'SELECT project_id FROM plans WHERE id = $1',
      [running.planId],
    );
    const projectId = rows[0]?.project_id ?? '';

    const bodies = [
      (await page('/ui/projects')).body,
      (await page(`/ui/projects/${projectId}`)).body,
      JSON.stringify(await live('/ui/live/projects')),
      JSON.stringify(await live(`/ui/live/projects/${projectId}`)),
    ];

    for (const body of bodies) {
      expect(body).not.toContain(running.planToken);
      expect(body).not.toContain('agent_token_hash');
      expect(body).not.toContain('gitea_bot_token');
      expect(body).not.toMatch(/token_hash/);
    }
  });

  /**
   * The plan schema makes a project name slug-shaped, so this cannot arrive
   * through `POST /plans` today — it is written straight to the row. The
   * escaping still has to hold: the schema is one deploy away from changing,
   * and a page that only escapes what it currently receives is not escaping.
   */
  it('escapes a project name as thoroughly as anything else', async () => {
    await h.pool.query(
      'INSERT INTO projects (id, name, gitea_repo, created_at) VALUES ($1, $2, NULL, $3)',
      [crypto.randomUUID(), '<script>alert(1)</script>', h.clock.now()],
    );

    const { body } = await page('/ui/projects');

    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).toContain('&lt;script&gt;');
  });
});
