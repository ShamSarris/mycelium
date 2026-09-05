import type { FastifyRequest } from 'fastify';
import type { Deps } from '../deps.js';
import { HttpError } from '../errors.js';
import { hashToken } from '../tokens.js';
import { AGENT_COLUMNS, type AgentRow } from '../services/supervisorsRegistry.js';
import { PLAN_COLUMNS, type PlanRow } from '../services/plans.js';

export type Caller =
  | { kind: 'supervisor'; agent: AgentRow }
  | { kind: 'agent'; plan: PlanRow };

function bearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.toLowerCase().startsWith('bearer ')) {
    throw HttpError.unauthorized('expected a bearer token');
  }
  const token = header.slice(7).trim();
  if (token === '') throw HttpError.unauthorized('expected a bearer token');
  return token;
}

/**
 * Only the hash is ever stored (baseline section 7), so the lookup is by hash.
 * A miss is indistinguishable from a wrong token, which is the point.
 */
export async function requireSupervisor(deps: Deps, request: FastifyRequest): Promise<AgentRow> {
  const hash = hashToken(bearerToken(request));
  const { rows } = await deps.pool.query<AgentRow>(
    `SELECT ${AGENT_COLUMNS} FROM agents WHERE token_hash = $1`,
    [hash],
  );
  const agent = rows[0];
  if (!agent) throw HttpError.unauthorized('unknown supervisor token');
  if (!agent.enabled) throw HttpError.forbidden('supervisor is disabled');
  return agent;
}

/**
 * Per-plan tokens are minted at approval and destroyed at teardown, so a token
 * whose plan is no longer running authorises nothing.
 */
export async function requirePlan(deps: Deps, request: FastifyRequest): Promise<PlanRow> {
  const hash = hashToken(bearerToken(request));
  const { rows } = await deps.pool.query<PlanRow>(
    `SELECT ${PLAN_COLUMNS} FROM plans WHERE agent_token_hash = $1`,
    [hash],
  );
  const plan = rows[0];
  if (!plan) throw HttpError.unauthorized('unknown plan token');
  if (plan.state !== 'running') {
    throw HttpError.conflict('plan_not_running', `plan is ${plan.state}`);
  }
  return plan;
}

/** Resolves whichever of the two machine identities presented the token. */
export async function requireMachine(deps: Deps, request: FastifyRequest): Promise<Caller> {
  const hash = hashToken(bearerToken(request));

  const { rows: agents } = await deps.pool.query<AgentRow>(
    `SELECT ${AGENT_COLUMNS} FROM agents WHERE token_hash = $1`,
    [hash],
  );
  const agent = agents[0];
  if (agent) {
    if (!agent.enabled) throw HttpError.forbidden('supervisor is disabled');
    return { kind: 'supervisor', agent };
  }

  const { rows: plans } = await deps.pool.query<PlanRow>(
    `SELECT ${PLAN_COLUMNS} FROM plans WHERE agent_token_hash = $1`,
    [hash],
  );
  const plan = plans[0];
  if (!plan) throw HttpError.unauthorized('unknown token');
  if (plan.state !== 'running') {
    throw HttpError.conflict('plan_not_running', `plan is ${plan.state}`);
  }
  return { kind: 'agent', plan };
}
