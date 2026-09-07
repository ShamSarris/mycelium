import type { FastifyInstance } from 'fastify';
import type { Deps } from '../deps.js';
import { HttpError } from '../errors.js';
import { requireOperator } from '../auth/operator.js';
import {
  approvePlan,
  cancelPlan,
  getPlanRow,
  listPlans,
  listTasks,
  proposePlan,
  rejectPlan,
} from '../services/plans.js';
import { queryEvents } from '../services/events.js';
import { listAgents } from '../services/supervisorsRegistry.js';

/**
 * The operator surface. These routes are the approval gate (goal G2) and the
 * read side of the event log (G4). Every mutation is attributed and audited.
 */
export function registerOperatorRoutes(app: FastifyInstance, deps: Deps): void {
  app.post('/plans', async (request, reply) => {
    const operator = requireOperator(request, deps.config);
    const result = await proposePlan(deps, { body: request.body, operator });
    return reply.code(201).send(result);
  });

  app.get('/plans', async (request) => {
    requireOperator(request, deps.config);
    const query = request.query as { state?: string };
    const plans = await listPlans(deps, query.state === undefined ? {} : { state: query.state });
    return { plans: plans.map(publicPlan) };
  });

  app.get('/plans/:id', async (request) => {
    requireOperator(request, deps.config);
    const { id } = request.params as { id: string };
    const plan = await getPlanRow(deps, id);
    const tasks = await listTasks(deps, id);
    return {
      plan: publicPlan(plan),
      tasks: tasks.map((task) => ({
        id: task.id,
        local_id: task.local_id,
        state: task.state,
        execution_attempt: task.execution_attempt,
        dispatch_attempt: task.dispatch_attempt,
        tokens_spent: task.tokens_spent,
        error: task.error,
        started_at: task.started_at,
        finished_at: task.finished_at,
      })),
      manifest: plan.manifest,
    };
  });

  app.post('/plans/:id/approve', async (request) => {
    const operator = requireOperator(request, deps.config);
    const { id } = request.params as { id: string };
    return approvePlan(deps, { planId: id, operator });
  });

  app.post('/plans/:id/reject', async (request) => {
    const operator = requireOperator(request, deps.config);
    const { id } = request.params as { id: string };
    return rejectPlan(deps, { planId: id, operator });
  });

  app.post('/plans/:id/cancel', async (request) => {
    const operator = requireOperator(request, deps.config);
    const { id } = request.params as { id: string };
    return cancelPlan(deps, { planId: id, operator });
  });

  app.get('/projects', async (request) => {
    requireOperator(request, deps.config);
    const { rows } = await deps.pool.query(
      'SELECT id, name, gitea_repo, created_at FROM projects ORDER BY created_at DESC LIMIT 200',
    );
    return { projects: rows };
  });

  app.get('/projects/:id', async (request) => {
    requireOperator(request, deps.config);
    const { id } = request.params as { id: string };
    const { rows } = await deps.pool.query(
      'SELECT id, name, gitea_repo, created_at FROM projects WHERE id = $1',
      [id],
    );
    if (rows.length === 0) throw HttpError.notFound('project');
    return { project: rows[0] };
  });

  app.get('/agents', async (request) => {
    requireOperator(request, deps.config);
    const agents = await listAgents(deps);
    return {
      agents: agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        env: agent.env,
        base_url: agent.base_url,
        enabled: agent.enabled,
        priority: agent.priority,
        last_heartbeat_at: agent.last_heartbeat_at,
        healthy: agent.healthy,
      })),
    };
  });

  app.get('/events', async (request) => {
    requireOperator(request, deps.config);
    const query = request.query as { plan_id?: string; after?: string; limit?: string };
    if (query.plan_id === undefined || query.plan_id === '') {
      throw HttpError.badRequest('missing_filter', 'plan_id is required');
    }

    let limit: number | undefined;
    if (query.limit !== undefined) {
      const parsed = Number.parseInt(query.limit, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw HttpError.badRequest('invalid_limit', 'limit must be a positive integer');
      }
      limit = parsed;
    }

    const events = await queryEvents(deps, {
      planId: query.plan_id,
      after: query.after,
      limit,
    });
    return { events, next: events.at(-1)?.event_id ?? null };
  });
}

function publicPlan(plan: Awaited<ReturnType<typeof getPlanRow>>) {
  // The token hash is deliberately absent: it is of no use to the operator and
  // every place it does not appear is a place it cannot leak.
  return {
    id: plan.id,
    project_id: plan.project_id,
    state: plan.state,
    env: plan.env,
    goal: plan.spec.goal,
    assumptions: plan.spec.assumptions,
    // The rest of what approval actually covers. Assumptions alone are not it:
    // the non-goals are the only thing stopping an agent widening its own
    // scope, and the ceilings are what stop it spending the month. Defaults
    // are resolved here rather than returned as absences, because a blank
    // reads as "no limit" and every one of these has one.
    non_goals: plan.spec.non_goals ?? [],
    egress: plan.spec.egress ?? [],
    max_cost_microusd: plan.spec.max_cost_microusd,
    // Stopgap: max_concurrent_agents left the plan schema (agent-sdk-migration
    // tickets 03/04); ticket 13 replaces this with a supervisor-derived value.
    // Hardcoded until then.
    max_concurrent_agents: 2,
    env_ttl_min: plan.spec.env_ttl_min ?? 240,
    proposed_at: plan.proposed_at,
    proposed_by: plan.proposed_by,
    approved_at: plan.approved_at,
    approved_by: plan.approved_by,
    agent_id: plan.agent_id,
    gitea_branch: plan.gitea_branch,
    ttl_expires_at: plan.ttl_expires_at,
    terminal_reason: plan.terminal_reason,
    manifest: plan.manifest,
  };
}
