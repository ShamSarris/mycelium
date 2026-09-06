import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, operatorHeaders, type TestHarness } from './helpers/app.js';
import { propose, validPlan } from './helpers/fixtures.js';

/**
 * The document shell: the parts every page carries, asserted once here rather
 * than repeatedly in the page tests.
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

describe('the favicon', () => {
  /**
   * Without an icon the browser requests /favicon.ico on every navigation, the
   * request falls through to the JSON not-found handler, and the tab icon
   * oscillates between a loading spinner and the generic glyph. On a phone's
   * tab overview that reads as a card that will not sit still.
   *
   * It is inlined as a data URI because `pnpm build` runs tsc and copies no
   * assets: a file in a directory would ship as nothing.
   */
  it('is declared inline, so the tab icon never has to be fetched', async () => {
    const { body } = await page('/ui');

    expect(body).toContain('<link rel="icon"');
    expect(body).toContain('data:image/svg+xml');
  });

  it('is declared on every page, not just the overview', async () => {
    const { plan_id } = await propose(h, validPlan());
    const { body } = await page(`/ui/plans/${plan_id}`);

    expect(body).toContain('<link rel="icon"');
  });

  /**
   * Belt and braces: Safari and others ask for /favicon.ico regardless of the
   * link tag. This route is deliberately outside `requireOperator` — a 401
   * would send the browser back to the generic glyph, which is the thing the
   * icon exists to prevent. It carries no data, so there is nothing to leak.
   */
  it('answers /favicon.ico without an operator identity, and not with an error', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/favicon.ico' });

    expect(response.statusCode).toBeLessThan(400);
    expect(response.body).not.toContain('not_found');
  });
});

describe('the document shell', () => {
  it('tells the browser the page is dark, so the chrome matches it', async () => {
    const { body } = await page('/ui');

    expect(body).toContain('<meta name="theme-color"');
  });

  /**
   * Named as a literal so the reload cannot come back by accident. It threw
   * away scroll position, selection and focus every five seconds, and made the
   * tab icon flicker along with it; the page patches regions in place instead.
   */
  it('never reloads itself', async () => {
    const { plan_id } = await propose(h, validPlan());

    for (const url of ['/ui', `/ui/plans/${plan_id}`]) {
      const { body } = await page(url);
      expect(body, url).not.toContain('location.reload');
    }
  });

  it('points every page at the fragment endpoint that refreshes it', async () => {
    const { plan_id } = await propose(h, validPlan());

    expect((await page('/ui')).body).toContain('data-live="/ui/live/overview"');
    expect((await page(`/ui/plans/${plan_id}`)).body).toContain(
      `data-live="/ui/live/plans/${plan_id}"`,
    );
  });

  /**
   * Without JavaScript the page is a snapshot and says so, rather than
   * claiming a freshness it cannot have.
   */
  it('states its own freshness, and admits it is static until the poll starts', async () => {
    const { body } = await page('/ui');

    expect(body).toMatch(/refreshed/);
    expect(body).toContain('<time id="as-of"');
    expect(body).toContain('>static<');
  });
});

describe('the nav', () => {
  const PAGES = ['/ui', '/ui/projects', '/ui/servers', '/ui/monitor'];

  /** Just the nav element: the stylesheet also mentions the current-page selector. */
  function navOf(body: string): string {
    return /<nav class="tabs">(.*?)<\/nav>/s.exec(body)?.[1] ?? '';
  }

  it('offers every page from every page', async () => {
    for (const url of PAGES) {
      const { body } = await page(url);
      for (const href of PAGES) {
        expect(body, `${url} -> ${href}`).toContain(`href="${href}"`);
      }
    }
  });

  it('marks exactly one tab as the one you are on', async () => {
    for (const url of PAGES) {
      const { body } = await page(url);
      const marked = navOf(body).match(/aria-current="page"/g) ?? [];
      expect(marked.length, url).toBe(1);
    }
  });

  /** A plan belongs to the overview; it is not a fifth tab. */
  it('keeps a plan under the overview tab', async () => {
    const { plan_id } = await propose(h, validPlan());
    const { body } = await page(`/ui/plans/${plan_id}`);

    expect(navOf(body)).toMatch(/href="\/ui"[^>]*aria-current="page"/);
  });

  it('puts the new pages behind the same operator check as the rest', async () => {
    for (const url of ['/ui/projects', '/ui/servers', '/ui/monitor']) {
      const anonymous = await h.app.inject({ method: 'GET', url });
      expect(anonymous.statusCode, url).toBe(401);

      const stranger = await page(url, { 'tailscale-user-login': 'nobody@example.com' });
      expect(stranger.statusCode, url).toBe(403);

      const operator = await page(url);
      expect(operator.statusCode, url).toBe(200);
      expect(operator.headers['content-type'], url).toContain('text/html');
    }
  });

  /**
   * They are stubs until the next phase, and they should say so rather than
   * render an empty page that looks broken.
   */
  it('says what each unbuilt page is for, rather than looking broken', async () => {
    for (const url of ['/ui/servers', '/ui/monitor']) {
      const { body } = await page(url);
      expect(body.toLowerCase(), url).toMatch(/not built yet|coming|will show/);
    }
  });
});
