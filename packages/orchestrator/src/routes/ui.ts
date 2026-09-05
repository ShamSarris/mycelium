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
import { overview, planPage } from '../views/pages.js';

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

  app.get('/ui', async (request, reply) => {
    requireOperator(request, deps.config);
    const now = deps.clock.now();

    const [plans, alerts, agents] = await Promise.all([
      listPlans(deps, {}),
      listAlerts(deps),
      listAgents(deps),
    ]);

    const counts = await taskCounts(deps, plans);

    return html(
      reply,
      overview({
        now,
        proposed: plans.filter((plan) => plan.state === 'proposed'),
        plans: plans.map((plan) => ({
          ...plan,
          tokensSpent: counts.get(plan.id)?.tokens ?? 0,
          taskCounts: counts.get(plan.id)?.states ?? {},
        })),
        alerts,
        workers: agents.map((agent) => ({
          ...agent,
          planIds: plans
            .filter((plan) => plan.agent_id === agent.id && !isTerminal(plan))
            .map((plan) => plan.id),
        })),
        healthyWithinMinutes: deps.config.heartbeatHealthyMinutes,
      }),
    );
  });

  app.get('/ui/plans/:id', async (request, reply) => {
    requireOperator(request, deps.config);
    const { id } = request.params as { id: string };

    const plan = await getPlanRow(deps, id);
    const [tasks, events] = await Promise.all([
      listTasks(deps, id),
      queryEvents(deps, { planId: id, limit: 50 }),
    ]);

    return html(reply, planPage({ now: deps.clock.now(), plan, tasks, events }));
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
