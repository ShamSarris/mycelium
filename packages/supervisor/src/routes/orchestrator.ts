import type { FastifyInstance } from 'fastify';
import { requirePeer } from '../auth/peer.js';
import type { Deps } from '../deps.js';
import { HttpError } from '../errors.js';
import type { DispatchOutcome } from '../drivers/process.js';
import { dispatchPlan } from '../environments/provision.js';
import { teardown, type TeardownReason } from '../environments/teardown.js';

/**
 * The server side of the orchestrator's `SupervisorClient`. The paths, the
 * bodies, and the status codes are all fixed by that already-shipped and
 * already-tested client; match it exactly.
 */
export function registerOrchestratorRoutes(app: FastifyInstance, deps: Deps): void {
  // Registered as a plugin so the peer hook is encapsulated to these three
  // routes. A hook added to the root instance would also close /healthz, which
  // has to stay curl-able.
  void app.register(async (scope) => {
    scope.addHook('preHandler', async (request) => {
      requirePeer(deps.config, request);
    });

    scope.post('/plans', async (request, reply) => {
      const result = await dispatchPlan(deps, request.body);
      return reply.code(202).send(result);
    });

    // A proxy, not a queue. The envelope is forwarded whole and nothing is
    // read out of it: the orchestrator owns the DAG, and a supervisor that
    // interpreted a task would be a second scheduler.
    scope.post('/plans/:id/tasks', async (request, reply) => {
      const { id } = request.params as { id: string };
      const environment = deps.ledger.get(id);
      if (environment === undefined) {
        throw HttpError.conflict('no_environment', 'this node is not running that plan');
      }
      if (environment.agent.hasExited()) {
        throw HttpError.conflict('agent_not_accepting', 'the plan agent has exited');
      }

      // Refuse loudly rather than accept quietly. The orchestrator returns the
      // task to ready at once on a refusal; a silent acceptance would cost it
      // the full lease before anything happened.
      //
      // Loudly means *with the reason*. A rejected dispatch is redispatched
      // roughly every two seconds until the plan's TTL, so a refusal with no
      // cause attached produces hundreds of identical `supervisor_rejected`
      // events and no way to tell which of four paths produced them. The
      // agent's own error is the diagnosis; it goes to the log and into the
      // 409 body, which is what the orchestrator records against the task.
      let outcome: DispatchOutcome;
      try {
        outcome = await environment.agent.dispatch(request.body);
      } catch (error) {
        request.log.warn({ err: error, planId: id }, 'could not reach the plan agent');
        throw HttpError.conflict('agent_not_accepting', 'the plan agent could not be reached');
      }

      if (!outcome.accepted) {
        request.log.warn(
          { planId: id, reason: outcome.reason, unreachable: outcome.unreachable },
          'the plan agent did not accept the task',
        );
        throw HttpError.conflict('agent_not_accepting', outcome.reason);
      }

      return reply.code(202).send({ accepted: true });
    });

    // Always 204, including for a plan this node has never heard of. The
    // orchestrator logs a failed authorization and never retries it, so the
    // only safe answer is one that cannot fail.
    scope.post('/plans/:id/teardown', async (request, reply) => {
      const { id } = request.params as { id: string };
      const { reason } = (request.body ?? {}) as { reason?: string };

      try {
        await teardown(deps, id, asReason(reason));
      } catch (error) {
        request.log.error({ err: error, planId: id }, 'teardown did not complete cleanly');
      }

      return reply.code(204).send();
    });
  });
}

/** An unrecognised reason still tears down; only the recorded label changes. */
function asReason(reason: string | undefined): TeardownReason {
  const known: TeardownReason[] = ['completion', 'ttl_expired', 'cancelled', 'failed'];
  return known.includes(reason as TeardownReason) ? (reason as TeardownReason) : 'failed';
}
