import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Deps } from '../deps.js';
import { HttpError } from '../errors.js';
import { requireOperator } from '../auth/operator.js';
import { acknowledgeAlert, listAlerts } from '../services/alerts.js';
import { queryEvents, subagentActivity } from '../services/events.js';
import { monitorSummary, parseWindowDays } from '../services/monitor.js';
import {
  approvePlan,
  cancelPlan,
  getPlanRow,
  countPlans,
  listPlans,
  listTasks,
  rejectPlan,
  taskRollup,
  PLAN_PAGE_SIZE,
  type PlanRow,
} from '../services/plans.js';
import { getProjectRow, listProjects } from '../services/projects.js';
import { listAgents } from '../services/supervisorsRegistry.js';
import { renderPage, version, type PageParts } from '../views/html.js';
import { monitorPage } from '../views/monitor.js';
import { overviewPage } from '../views/overview.js';
import { planPage } from '../views/plan.js';
import { projectPage, projectsPage } from '../views/projects.js';
import { serversPage } from '../views/servers.js';
import { viewAgent, viewPlan } from '../views/model.js';

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
    return html(reply, renderPage(overviewPage(await overviewModel(deps, request, now)), now));
  });

  app.get('/ui/plans/:id', async (request, reply) => {
    requireOperator(request, deps.config);
    const { id } = request.params as { id: string };
    const now = deps.clock.now();
    return html(reply, renderPage(planPage(await planModel(deps, id, now)), now));
  });

  app.get('/ui/projects', async (request, reply) => {
    requireOperator(request, deps.config);
    const now = deps.clock.now();
    return html(reply, renderPage(projectsPage(await projectsModel(deps, now)), now));
  });

  app.get('/ui/projects/:id', async (request, reply) => {
    requireOperator(request, deps.config);
    const { id } = request.params as { id: string };
    const now = deps.clock.now();
    return html(reply, renderPage(projectPage(await projectModel(deps, id, now)), now));
  });

  app.get('/ui/servers', async (request, reply) => {
    requireOperator(request, deps.config);
    const now = deps.clock.now();
    return html(reply, renderPage(serversPage(await serversModel(deps, now)), now));
  });

  app.get('/ui/monitor', async (request, reply) => {
    requireOperator(request, deps.config);
    const now = deps.clock.now();
    return html(reply, renderPage(monitorPage(await monitorModel(deps, request, now)), now));
  });

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
    return fragments(reply, overviewPage(await overviewModel(deps, request, now)), now);
  });

  app.get('/ui/live/plans/:id', async (request, reply) => {
    requireOperator(request, deps.config);
    const { id } = request.params as { id: string };
    const now = deps.clock.now();
    return fragments(reply, planPage(await planModel(deps, id, now)), now);
  });

  app.get('/ui/live/projects', async (request, reply) => {
    requireOperator(request, deps.config);
    const now = deps.clock.now();
    return fragments(reply, projectsPage(await projectsModel(deps, now)), now);
  });

  app.get('/ui/live/projects/:id', async (request, reply) => {
    requireOperator(request, deps.config);
    const { id } = request.params as { id: string };
    const now = deps.clock.now();
    return fragments(reply, projectPage(await projectModel(deps, id, now)), now);
  });

  app.get('/ui/live/servers', async (request, reply) => {
    requireOperator(request, deps.config);
    const now = deps.clock.now();
    return fragments(reply, serversPage(await serversModel(deps, now)), now);
  });

  app.get('/ui/live/monitor', async (request, reply) => {
    requireOperator(request, deps.config);
    const now = deps.clock.now();
    return fragments(reply, monitorPage(await monitorModel(deps, request, now)), now);
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
async function overviewModel(deps: Deps, request: FastifyRequest, now: Date) {
  const { page } = request.query as { page?: string };

  // Two of the overview's four sections read plans for a purpose that has
  // nothing to do with the table's page: needs-attention must announce every
  // proposed plan, and a worker's placement count must count every plan on
  // that VM. Paginating one query for all three is exactly how a decision
  // stops being announced because it fell to page two — so the active plans
  // are their own query, and only the table is paged.
  const [total, active, alerts, agents] = await Promise.all([
    countPlans(deps, {}),
    listPlans(deps, { states: ACTIVE_STATES }),
    listAlerts(deps),
    listAgents(deps),
  ]);

  const pageCount = Math.max(1, Math.ceil(total / PLAN_PAGE_SIZE));
  const current = clampPage(page, pageCount);
  const plans = await listPlans(deps, {
    limit: PLAN_PAGE_SIZE,
    offset: (current - 1) * PLAN_PAGE_SIZE,
  });

  const counts = await taskRollup(deps, plans.map((plan) => plan.id));

  return {
    now,
    proposed: active.filter((plan) => plan.state === 'proposed').map(viewPlan),
    plans: plans.map((plan) => ({
      ...viewPlan(plan),
      costMicrousd: counts.get(plan.id)?.costMicrousd ?? 0,
      taskCounts: counts.get(plan.id)?.states ?? {},
    })),
    pager: { page: current, pageCount, path: '/ui' },
    alerts,
    workers: agents.map((agent) => ({
      ...viewAgent(agent),
      // `active` is already every non-terminal plan, so the `isTerminal`
      // filter this used to carry is now the query's own job.
      planIds: active.filter((plan) => plan.agent_id === agent.id).map((plan) => plan.id),
    })),
    healthyWithinMinutes: deps.config.heartbeatHealthyMinutes,
  };
}

/** Every state `isTerminal` says is not terminal. Named here so the two cannot drift. */
const ACTIVE_STATES = ['proposed', 'queued', 'provisioning', 'running'] as const;

/**
 * A page number from a query string is operator input via the address bar: it
 * can be absent, a word, a negative, or past the end. None of those is worth
 * a 400 on a dashboard — landing on the nearest real page is what someone
 * editing the url by hand actually wants.
 */
function clampPage(value: string | undefined, pageCount: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.min(parsed, pageCount);
}

/** As `overviewModel`, for one plan. Throws the same 404 both routes need. */
async function planModel(deps: Deps, planId: string, now: Date) {
  const plan = await getPlanRow(deps, planId);
  // Subagent activity is its own query rather than a fold over `events`
  // above: that window is the oldest 50 rows, and the section exists for
  // exactly the long plan whose subagents fall outside it.
  const [tasks, events, subagents] = await Promise.all([
    listTasks(deps, planId),
    queryEvents(deps, { planId, limit: 50 }),
    subagentActivity(deps, planId),
  ]);

  return { now, plan: viewPlan(plan), tasks, events, subagents };
}

/** Every project, with the plan counts and spend each has accumulated. */
async function projectsModel(deps: Deps, now: Date) {
  return { now, projects: await listProjects(deps) };
}

/**
 * One project and its plans, rendered through the overview's plan table. The
 * 404 for an unknown id comes from `getProjectRow`, so the page and its
 * fragment refuse identically and the poll stops rather than retrying.
 */
async function projectModel(deps: Deps, projectId: string, now: Date) {
  const project = await getProjectRow(deps, projectId);
  const plans = await listPlans(deps, { projectId });
  const counts = await taskRollup(deps, plans.map((plan) => plan.id));

  return {
    now,
    project,
    plans: plans.map((plan) => ({
      ...viewPlan(plan),
      costMicrousd: counts.get(plan.id)?.costMicrousd ?? 0,
      taskCounts: counts.get(plan.id)?.states ?? {},
    })),
  };
}

/**
 * The fleet, and what is placed on each VM. The placement comes from the same
 * plan list the overview uses rather than a per-agent query: an unhealthy VM's
 * stranded plans are the reason to look at this page at all, and they have to
 * be the same plans the overview is naming.
 */
async function serversModel(deps: Deps, now: Date) {
  const [agents, plans] = await Promise.all([listAgents(deps), listPlans(deps, {})]);

  return {
    now,
    healthyWithinMinutes: deps.config.heartbeatHealthyMinutes,
    attention: plans.filter((plan) => plan.state === 'proposed').length,
    servers: agents.map((agent) => ({
      ...viewAgent(agent),
      plans: plans
        .filter((plan) => plan.agent_id === agent.id && !isTerminal(plan))
        .map(viewPlan),
    })),
  };
}

/**
 * The aggregates, over a window taken from the query string. An unusable
 * `days` falls back to a week rather than 400ing: it is a stale bookmark or a
 * typo, and the operator asked for the monitor, not for an error page.
 */
async function monitorModel(deps: Deps, request: FastifyRequest, now: Date) {
  const { days } = request.query as { days?: string };
  return { now, summary: await monitorSummary(deps, parseWindowDays(days)) };
}

function isTerminal(plan: PlanRow): boolean {
  return ['done', 'failed', 'rejected', 'cancelled'].includes(plan.state);
}
