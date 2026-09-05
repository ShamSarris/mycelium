import Fastify, { type FastifyInstance } from 'fastify';
import type { Deps } from './deps.js';
import { HttpError } from './errors.js';
import { IllegalTransition } from './domain/states.js';
import { registerOperatorRoutes } from './routes/operator.js';
import { registerMachineRoutes } from './routes/machine.js';
import { registerUiRoutes } from './routes/ui.js';

export interface BuildOptions {
  logger?: boolean;
}

/**
 * A pure function of its dependencies, so it can be built many times in one
 * process and every test gets its own instance with its own clock and fakes.
 */
export function buildApp(deps: Deps, options: BuildOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false,
    // Plan bodies can carry 50 tasks of 8000 characters each.
    bodyLimit: 4 * 1024 * 1024,
  });

  app.setErrorHandler((raw, request, reply) => {
    // Fastify 5 hands the handler an unknown; narrow once, here.
    const error = raw as Error & { statusCode?: number; code?: string };

    if (error instanceof HttpError) {
      return reply.code(error.status).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.issues ? { issues: error.issues } : {}),
        },
      });
    }

    if (error instanceof IllegalTransition) {
      return reply
        .code(409)
        .send({ error: { code: error.code, message: error.message } });
    }

    if (error.statusCode !== undefined && error.statusCode < 500) {
      return reply.code(error.statusCode).send({
        error: { code: error.code ?? 'bad_request', message: error.message },
      });
    }

    request.log.error({ err: error }, 'unhandled error');
    return reply.code(500).send({
      error: { code: 'internal_error', message: 'internal error' },
    });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: { code: 'not_found', message: 'no such route' } }),
  );

  app.get('/healthz', async () => ({ status: 'ok' }));

  registerOperatorRoutes(app, deps);
  registerMachineRoutes(app, deps);
  registerUiRoutes(app, deps);

  return app;
}
