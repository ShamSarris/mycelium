import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, bearer, operatorHeaders, type TestHarness } from './helpers/app.js';
import { propose, registerSupervisor, runningPlan, validPlan } from './helpers/fixtures.js';

/**
 * The update mechanism, asserted entirely server-side.
 *
 * The page polls a fragment endpoint and replaces only the regions whose
 * version changed. That is why the fragments are rendered markup rather than
 * data for the client to template: escaping, the "never render a token hash"
 * rule and every empty state stay in one place, where `app.inject()` already
 * reaches them. A client-side template language would be a second
 * implementation of all three that no test here could see.
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

async function live(url = '/ui/live/overview'): Promise<Envelope> {
  const response = await page(url);
  expect(response.statusCode).toBe(200);
  return response.json() as Envelope;
}

/** The `data-v` the document is carrying for each region, as the client sees it. */
function versionsIn(body: string): Record<string, string> {
  const found: Record<string, string> = {};
  const pattern = /data-region="([^"]+)" data-v="([^"]+)"/g;
  for (let m = pattern.exec(body); m !== null; m = pattern.exec(body)) {
    found[m[1] as string] = m[2] as string;
  }
  return found;
}

describe('access', () => {
  it('is behind the same operator check as the pages it feeds', async () => {
    const anonymous = await h.app.inject({ method: 'GET', url: '/ui/live/overview' });
    expect(anonymous.statusCode).toBe(401);

    const stranger = await page('/ui/live/overview', {
      'tailscale-user-login': 'nobody@example.com',
    });
    expect(stranger.statusCode).toBe(403);
  });

  it('refuses a machine credential, which is not an operator', async () => {
    const supervisor = await registerSupervisor(h);
    const response = await page('/ui/live/overview', bearer(supervisor.token));
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('is JSON, and is never cached', async () => {
    const response = await page('/ui/live/overview');
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.headers['cache-control']).toContain('no-store');
  });
});

describe('the envelope', () => {
  it('carries when it was built, what needs attention, and the regions', async () => {
    const body = await live();

    expect(typeof body.as_of).toBe('string');
    expect(typeof body.attention).toBe('number');
    expect(Object.keys(body.regions).sort()).toEqual(['alerts', 'attention', 'plans', 'workers']);
  });

  it('counts the plans waiting on a decision, which becomes the tab badge', async () => {
    expect((await live()).attention).toBe(0);

    await propose(h, validPlan());
    expect((await live()).attention).toBe(1);
  });
});

describe('parity with the page', () => {
  /**
   * The anti-drift property, and the reason this design is testable at all: the
   * document and the fragment come from the same renderer, so the markup the
   * poll installs is byte-for-byte the markup a reload would have produced.
   */
  it('renders each region exactly as the document already has it', async () => {
    await propose(h, validPlan());
    const { body } = await page('/ui');
    const envelope = await live();

    for (const [id, region] of Object.entries(envelope.regions)) {
      expect(body, id).toContain(region.html);
    }
  });

  it('agrees with the document about every region version', async () => {
    await propose(h, validPlan());
    const { body } = await page('/ui');
    const envelope = await live();

    const onPage = versionsIn(body);
    for (const [id, region] of Object.entries(envelope.regions)) {
      expect(onPage[id], id).toBe(region.v);
    }
  });
});

describe('versions', () => {
  /**
   * This is what "does not flash" means, stated as an assertion: with nothing
   * changing, every version is identical, so the client patches nothing and
   * scroll, selection and focus survive.
   */
  it('does not change while nothing does', async () => {
    await propose(h, validPlan());

    const first = await live();
    const second = await live();

    for (const id of Object.keys(first.regions)) {
      expect(second.regions[id]?.v, id).toBe(first.regions[id]?.v);
    }
  });

  it('changes only for the regions a change actually touched', async () => {
    const before = await live();
    await propose(h, validPlan());
    const after = await live();

    expect(after.regions.attention?.v).not.toBe(before.regions.attention?.v);
    expect(after.regions.plans?.v).not.toBe(before.regions.plans?.v);
    // Nobody registered or unregistered a supervisor, so this must not move —
    // if it does, the page repaints a table the operator may be reading.
    expect(after.regions.workers?.v).toBe(before.regions.workers?.v);
  });
});

describe('one plan', () => {
  it('feeds the plan page too', async () => {
    const { plan_id } = await propose(h, validPlan());
    const envelope = await live(`/ui/live/plans/${plan_id}`);

    expect(Object.keys(envelope.regions)).toContain('tasks');
    expect(Object.keys(envelope.regions)).toContain('events');
  });

  /**
   * The client stops polling on a 404 rather than hammering a route that will
   * not start working again.
   */
  it('is a 404 once the plan is not there, so the poll gives up', async () => {
    const response = await page('/ui/live/plans/018f3a5c-0000-7000-8000-0000000000ff');
    expect(response.statusCode).toBe(404);
  });
});

describe('what a fragment must never carry', () => {
  it('renders no token, hash or bot credential', async () => {
    const running = await runningPlan(h, validPlan());
    const overview = JSON.stringify(await live());
    const detail = JSON.stringify(await live(`/ui/live/plans/${running.planId}`));

    for (const body of [overview, detail]) {
      expect(body).not.toContain(running.planToken);
      expect(body).not.toContain('agent_token_hash');
      expect(body).not.toContain('gitea_bot_token');
      expect(body).not.toMatch(/token_hash/);
    }
  });

  it('escapes a plan goal in the fragment as thoroughly as in the page', async () => {
    await propose(h, { ...validPlan(), goal: 'Add <script>alert(1)</script>' });
    const body = JSON.stringify(await live());

    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).toContain('&lt;script&gt;');
  });
});
