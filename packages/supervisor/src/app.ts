import Fastify, { type FastifyInstance } from 'fastify';
import type { Deps } from './deps.js';
import { HttpError } from './errors.js';
import { IllegalTransition } from './domain/states.js';
import { registerOrchestratorRoutes } from './routes/orchestrator.js';

export interface BuildOptions {
  logger?: boolean;
}

/**
 * A pure function of its dependencies, like the orchestrator's, so every test
 * gets its own instance with its own clock, ledger, and drivers.
 *
 * Note the error shape: `{ code, message }` at the top level. See errors.ts —
 * the orchestrator's already-shipped client depends on it.
 */
export function buildApp(deps: Deps, options: BuildOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false,
    // A plan dispatch is small; a task dispatch carries an 8000-character
    // description. Neither is close to this.
    bodyLimit: 1024 * 1024,
  });

  app.setErrorHandler((raw, request, reply) => {
    const error = raw as Error & { statusCode?: number; code?: string };

    if (error instanceof HttpError) {
      return reply.code(error.status).send({ code: error.code, message: error.message });
    }

    if (error instanceof IllegalTransition) {
      return reply.code(409).send({ code: error.code, message: error.message });
    }

    if (error.statusCode !== undefined && error.statusCode < 500) {
      return reply
        .code(error.statusCode)
        .send({ code: error.code ?? 'bad_request', message: error.message });
    }

    request.log.error({ err: error }, 'unhandled error');
    return reply.code(500).send({ code: 'internal_error', message: 'internal error' });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ code: 'not_found', message: 'no such route' }),
  );

  // Deliberately outside the peer allowlist so the operator can curl it, and
  // deliberately free of plan ids and addresses.
  // The same object the heartbeat carries, from the same function, so what the
  // operator curls and what the dashboard renders cannot disagree.
  app.get('/healthz', async () => ({
    ok: true,
    environments: deps.ledger.size,
    capacity: deps.config.maxEnvironments,
    metrics: await deps.metrics().catch(() => null),
  }));

  registerOrchestratorRoutes(app, deps);

  return app;
}
