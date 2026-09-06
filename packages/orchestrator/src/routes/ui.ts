import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Deps } from '../deps.js';
import { HttpError } from '../errors.js';
import { requireOperator } from '../auth/operator.js';
import { acknowledgeAlert, listAlerts } from '../services/alerts.js';
import { queryEvents } from '../services/events.js';
import {
  approvePlan,
  cancelPlan,
  getPlanRow,
  listPlans,
  listTasks,
  rejectPlan,
  type PlanRow,
} from '../services/plans.js';
import { listAgents } from '../services/supervisorsRegistry.js';
import { renderPage, version, type PageParts } from '../views/html.js';
import { overviewPage } from '../views/overview.js';
import { planPage } from '../views/plan.js';
import { viewAgent, viewPlan } from '../views/model.js';
import { stubPage } from '../views/stub.js';

/**
 * The dashboard: server-rendered pages over the same services the JSON routes
 * use, behind the same `requireOperator`. It adds no authentication of its own
 * and must not — the identity still comes from Serve, into a loopback-only
 * listener, checked against the operator allowlist.
 *
 * Mounted under `/ui` so the JSON routes keep their paths. Content negotiation
 * on the same paths was considered and rejected: two response shapes per route
 * is an SPA's cost without its benefit.
 */
export function registerUiRoutes(app: FastifyInstance, deps: Deps): void {
  // HTML forms post urlencoded. Fastify parses only JSON out of the box, and
  // that accident is currently the only thing protecting the JSON routes from
  // cross-site posts — so adding this parser is exactly what makes the origin
  // check below necessary rather than decorative.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    },
  );

  app.get('/', async (_request, reply) => reply.redirect('/ui', 302));

  /**
   * Safari and others ask for this regardless of the `<link rel="icon">` the
   * layout carries, and without a route it falls through to the JSON
   * not-found handler — which is what made the tab icon flicker between a
   * spinner and the generic glyph on every navigation.
   *
   * Deliberately outside `requireOperator`, and the second route that is
   * after `/healthz`: a 401 here would send the browser back to the generic
   * glyph, which is the thing the icon exists to prevent. An empty 204
   * carries nothing, so there is nothing to leak by answering it.
   */
  app.get('/favicon.ico', async (_request, reply) =>
    reply.code(204).header('cache-control', 'public, max-age=604800, immutable').send(),
  );

  app.get('/ui', async (request, reply) => {
    requireOperator(request, deps.config);
    const now = deps.clock.now();
    return html(reply, renderPage(overviewPage(await overviewModel(deps, now)), now));
  });

  app.get('/ui/plans/:id', async (request, reply) => {
    requireOperator(request, deps.config);
    const { id } = request.params as { id: string };
    const now = deps.clock.now();
    return html(reply, renderPage(planPage(await planModel(deps, id, now)), now));
  });

  /**
   * The three pages the next phase fills in. They ship now so the nav is whole
   * and the shell can be judged before anything is built on top of it.
   */
  const STUBS = [
    ['projects', '/ui/projects', 'projects', 'every project, its plans, and what each has spent.'],
    ['servers', '/ui/servers', 'servers', 'each worker VM, its health, and what it is running.'],
    ['monitor', '/ui/monitor', 'monitor', 'what has run, what failed, and where the tokens went.'],
  ] as const;

  for (const [nav, path, title, willShow] of STUBS) {
    app.get(path, async (request, reply) => {
      requireOperator(request, deps.config);
      return html(reply, renderPage(stubPage(nav, title, willShow), deps.clock.now()));
    });
  }

  /**
   * The fragment routes. Each renders the same `PageParts` its document route
   * does, so the markup a poll installs is the markup a reload would have
   * produced and the two cannot drift.
   *
   * Deliberately without `sameOrigin`, unlike every mutating route below: these
   * are GETs with no side effects, and a cross-origin `fetch()` cannot read a
   * response without CORS headers, which nothing here ever sets. Adding the
   * guard would only break the page's own poll.
   */
  app.get('/ui/live/overview', async (request, reply) => {
    requireOperator(request, deps.config);
    const now = deps.clock.now();
    return fragments(reply, overviewPage(await overviewModel(deps, now)), now);
  });

  app.get('/ui/live/plans/:id', async (request, reply) => {
    requireOperator(request, deps.config);
    const { id } = request.params as { id: string };
    const now = deps.clock.now();
    return fragments(reply, planPage(await planModel(deps, id, now)), now);
  });

  for (const action of ['approve', 'reject', 'cancel'] as const) {
    app.post(`/ui/plans/:id/${action}`, async (request, reply) => {
      const operator = requireOperator(request, deps.config);
      sameOrigin(request);
      const { id } = request.params as { id: string };

      if (action === 'approve') await approvePlan(deps, { planId: id, operator });
      else if (action === 'reject') await rejectPlan(deps, { planId: id, operator });
      else await cancelPlan(deps, { planId: id, operator });

      // See-other, so a reload does not repeat the action.
      return reply.redirect(`/ui/plans/${id}`, 303);
    });
  }

  app.post('/ui/alerts/:eventId/ack', async (request, reply) => {
    const operator = requireOperator(request, deps.config);
    sameOrigin(request);
    const { eventId } = request.params as { eventId: string };

    await acknowledgeAlert(deps, { eventId, operator });
    return reply.redirect('/ui', 303);
  });
}

/**
 * The one genuinely new attack surface this dashboard creates.
 *
 * Serve injects the operator's identity header based on the tailnet
 * connection, not on anything the page proves — so a cross-origin form post
 * from any page in the operator's browser would arrive here fully
 * authenticated. Until this route existed, the JSON routes were protected only
 * by accident: a form post arrives as urlencoded, which Fastify had no parser
 * for. Adding that parser removed the accident.
 *
 * A browser sends `Origin` on cross-origin posts and `Sec-Fetch-Site` on
 * essentially all of them. Requiring one of the two to say same-origin is
 * enough; a request with neither is not a browser, and this surface is only
 * for browsers.
 */
function sameOrigin(request: FastifyRequest): void {
  const site = header(request, 'sec-fetch-site');
  if (site === 'same-origin' || site === 'none') return;
  if (site !== undefined) {
    throw HttpError.forbidden(`cross-site request refused (Sec-Fetch-Site: ${site})`);
  }

  const origin = header(request, 'origin');
  const host = header(request, 'host');
  if (origin === undefined || host === undefined) {
    throw HttpError.forbidden('a request with no Origin and no Sec-Fetch-Site is not a browser');
  }

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw HttpError.forbidden('malformed Origin');
  }

  if (originHost !== host) {
    throw HttpError.forbidden(`cross-origin request refused (Origin: ${originHost})`);
  }
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function html(reply: FastifyReply, body: string): FastifyReply {
  return reply.type('text/html; charset=utf-8').send(body);
}

/** One page's regions, versioned, for the poll to compare against the document. */
function fragments(reply: FastifyReply, parts: PageParts, now: Date): FastifyReply {
  const regions: Record<string, { v: string; html: string }> = {};
  for (const region of parts.regions) {
    regions[region.id] = { v: version(region.html), html: region.html };
  }

  return reply
    .type('application/json; charset=utf-8')
    .header('cache-control', 'no-store')
    .send({ as_of: now.toISOString(), attention: parts.attention, regions });
}

/**
 * Everything the overview shows, loaded once. The document route and the
 * fragment route both go through here rather than each assembling their own,
 * which is the only reason the two are guaranteed to agree.
 */
async function overviewModel(deps: Deps, now: Date) {
  const [plans, alerts, agents] = await Promise.all([
    listPlans(deps, {}),
    listAlerts(deps),
    listAgents(deps),
  ]);

  const counts = await taskCounts(deps, plans);

  return {
    now,
    proposed: plans.filter((plan) => plan.state === 'proposed').map(viewPlan),
    plans: plans.map((plan) => ({
      ...viewPlan(plan),
      tokensSpent: counts.get(plan.id)?.tokens ?? 0,
      taskCounts: counts.get(plan.id)?.states ?? {},
    })),
    alerts,
    workers: agents.map((agent) => ({
      ...viewAgent(agent),
      planIds: plans
        .filter((plan) => plan.agent_id === agent.id && !isTerminal(plan))
        .map((plan) => plan.id),
    })),
    healthyWithinMinutes: deps.config.heartbeatHealthyMinutes,
  };
}

/** As `overviewModel`, for one plan. Throws the same 404 both routes need. */
async function planModel(deps: Deps, planId: string, now: Date) {
  const plan = await getPlanRow(deps, planId);
  const [tasks, events] = await Promise.all([
    listTasks(deps, planId),
    queryEvents(deps, { planId, limit: 50 }),
  ]);

  return { now, plan: viewPlan(plan), tasks, events };
}

function isTerminal(plan: PlanRow): boolean {
  return ['done', 'failed', 'rejected', 'cancelled'].includes(plan.state);
}

/** Per-plan task states and spend, in one query rather than one per plan. */
async function taskCounts(
  deps: Deps,
  plans: PlanRow[],
): Promise<Map<string, { states: Record<string, number>; tokens: number }>> {
  const result = new Map<string, { states: Record<string, number>; tokens: number }>();
  if (plans.length === 0) return result;

  const { rows } = await deps.pool.query<{ plan_id: string; state: string; n: number; tokens: number }>(
    `SELECT plan_id, state::text AS state, count(*)::int AS n,
            coalesce(sum(tokens_spent), 0)::int AS tokens
       FROM tasks
      WHERE plan_id = ANY($1)
      GROUP BY plan_id, state`,
    [plans.map((plan) => plan.id)],
  );

  for (const row of rows) {
    const entry = result.get(row.plan_id) ?? { states: {}, tokens: 0 };
    entry.states[row.state] = row.n;
    entry.tokens += row.tokens;
    result.set(row.plan_id, entry);
  }

  return result;
}
