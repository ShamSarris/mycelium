import type { FastifyRequest } from 'fastify';
import type { OrchestratorConfig } from '../config.js';
import { HttpError } from '../errors.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Operator identity comes from the `Tailscale-User-Login` header that the Serve
 * proxy injects, having stripped any client-supplied copy. That header is only
 * trustworthy because the listener is unreachable except through Serve, so a
 * non-loopback connection is rejected outright rather than trusted.
 *
 * Attribution and authorisation are separate: the header says who acted, the
 * allowlist decides who may.
 */
export function requireOperator(request: FastifyRequest, config: OrchestratorConfig): string {
  const remote = request.socket.remoteAddress ?? '';
  if (!LOOPBACK.has(remote)) {
    throw HttpError.forbidden('operator routes accept loopback connections only');
  }

  const header = request.headers['tailscale-user-login'];
  const login = Array.isArray(header) ? header[0] : header;
  if (typeof login !== 'string' || login.trim() === '') {
    throw HttpError.unauthorized('missing Tailscale identity');
  }

  if (!config.operatorAllowlist.includes(login)) {
    throw HttpError.forbidden(`${login} is not on the operator allowlist`);
  }

  return login;
}
