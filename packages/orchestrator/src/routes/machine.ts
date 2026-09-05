import type { FastifyInstance } from 'fastify';
import type { Deps } from '../deps.js';
import { HttpError } from '../errors.js';
import { requireMachine, requirePlan, requireSupervisor } from '../auth/bearer.js';
import { ingestEvents } from '../services/events.js';
import { getAssignments, recordHeartbeat } from '../services/supervisorsRegistry.js';
import { reportTaskStatus } from '../services/tasks.js';

/**
 * The two machine surfaces: node supervisors and plan agents. Both authenticate
 * with a bearer token whose hash is the only copy the database holds.
 */
export function registerMachineRoutes(app: FastifyInstance, deps: Deps): void {
  app.post('/supervisors/:id/heartbeat', async (request) => {
    const agent = await requireSupervisor(deps, request);
    const { id } = request.params as { id: string };
    if (id !== agent.id) {
      throw HttpError.forbidden('token does not belong to that supervisor');
    }
    const { at } = await recordHeartbeat(deps, agent.id);
    return { supervisor_id: agent.id, last_heartbeat_at: at };
  });

  app.get('/supervisors/:id/assignments', async (request) => {
    const agent = await requireSupervisor(deps, request);
    const { id } = request.params as { id: string };
    if (id !== agent.id) {
      throw HttpError.forbidden('token does not belong to that supervisor');
    }
    return getAssignments(deps, agent.id);
  });

  // Shared by supervisors and plan agents; the token decides which, and the
  // envelope's `source` must agree with it.
  app.post('/events', async (request) => {
    const caller = await requireMachine(deps, request);

    if (caller.kind === 'supervisor') {
      return ingestEvents(deps, { kind: 'supervisor', agentId: caller.agent.id }, request.body);
    }

    return ingestEvents(
      deps,
      { kind: 'agent', agentId: caller.plan.agent_id, planId: caller.plan.id },
      request.body,
    );
  });

  app.post('/plans/:id/tasks/:taskId/status', async (request) => {
    const plan = await requirePlan(deps, request);
    const { id, taskId } = request.params as { id: string; taskId: string };
    if (id !== plan.id) {
      throw HttpError.forbidden('token does not cover that plan');
    }
    return reportTaskStatus(deps, { planId: plan.id, taskId, body: request.body });
  });
}
