import type { FastifyRequest } from 'fastify';
import { HttpError } from '../errors.js';
import type { SupervisorConfig } from '../config.js';

/**
 * B19: the orchestrator is authenticated by its tailnet address. Section 7
 * stores only the hash of this supervisor's own bearer token, so the
 * orchestrator has nothing to present back, and a sixth long-lived secret was
 * rejected as a fleet-wide rotation burden.
 *
 * This is real authentication only because `loadConfig` refuses a wildcard
 * bind: a packet on the WireGuard interface cannot forge its source address,
 * but one arriving on any other interface can.
 */
export function requirePeer(config: SupervisorConfig, request: FastifyRequest): void {
  const address = normaliseAddress(request.socket.remoteAddress);

  if (address === null || !config.orchestratorPeers.includes(address)) {
    // The address stays out of the response. A caller that is not the
    // orchestrator learns only that it was refused.
    request.log.warn({ peer: address }, 'refused a dispatch from an unlisted peer');
    throw HttpError.forbidden('peer_not_allowed', 'this address may not dispatch to this node');
  }
}

/**
 * Node reports an IPv4 peer on a dual-stack socket as `::ffff:100.64.0.1`, so
 * the mapped form has to reduce to the address an operator wrote in the config.
 */
export function normaliseAddress(address: string | undefined): string | null {
  if (address === undefined || address === '') return null;
  const trimmed = address.trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(trimmed);
  return mapped?.[1] ?? trimmed;
}
