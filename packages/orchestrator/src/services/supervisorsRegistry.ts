import type { Deps } from '../deps.js';
import { HttpError } from '../errors.js';
import { withTransaction } from '../db/pool.js';
import { isHealthy, type SupervisorCandidate } from '../domain/selection.js';
import { recordEvent } from './events.js';
import { hashToken, mintToken } from '../tokens.js';

export interface AgentRow extends SupervisorCandidate {
  token_hash: string;
  created_at: Date;
}

export const AGENT_COLUMNS = `id, name, env, base_url, token_hash, enabled, priority,
  last_heartbeat_at, created_at`;

/**
 * Static discovery: a supervisor is a row an operator inserts, not something
 * that self-registers, so an unknown VM cannot join by asking (baseline
 * section 6). The plaintext token is returned once and never stored.
 */
export async function registerSupervisor(
  deps: Deps,
  input: { name: string; env: 'dev' | 'prod'; baseUrl: string; priority?: number },
): Promise<{ id: string; token: string }> {
  const id = deps.newId();
  const token = mintToken();

  await deps.pool.query(
    `INSERT INTO agents (id, name, env, base_url, token_hash, enabled, priority, created_at)
     VALUES ($1, $2, $3, $4, $5, true, $6, $7)`,
    [id, input.name, input.env, input.baseUrl, hashToken(token), input.priority ?? 100, deps.clock.now()],
  );

  return { id, token };
}

export async function recordHeartbeat(deps: Deps, agentId: string): Promise<{ at: Date }> {
  const now = deps.clock.now();

  await withTransaction(deps.pool, async (client) => {
    const { rowCount } = await client.query(
      'UPDATE agents SET last_heartbeat_at = $2 WHERE id = $1',
      [agentId, now],
    );
    if (rowCount === 0) throw HttpError.notFound('supervisor');

    await recordEvent(client, deps, {
      type: 'supervisor.heartbeat',
      severity: 'debug',
      payload: { agent_id: agentId },
    });
  });

  return { at: now };
}

export async function listAgents(deps: Deps): Promise<Array<AgentRow & { healthy: boolean }>> {
  const { rows } = await deps.pool.query<AgentRow>(
    `SELECT ${AGENT_COLUMNS} FROM agents ORDER BY priority, id`,
  );
  const now = deps.clock.now();
  const windowMs = deps.config.heartbeatHealthyMinutes * 60_000;
  return rows.map((row) => ({ ...row, healthy: isHealthy(row, now, windowMs) }));
}

export async function getAgentById(deps: Deps, agentId: string): Promise<AgentRow | undefined> {
  const { rows } = await deps.pool.query<AgentRow>(
    `SELECT ${AGENT_COLUMNS} FROM agents WHERE id = $1`,
    [agentId],
  );
  return rows[0];
}

export interface Assignments {
  plans: Array<{ plan_id: string; state: string; project_id: string }>;
  /** Highest seq this supervisor has successfully delivered, per stream. */
  high_water_marks: Array<{ stream_id: string; seq: number }>;
}

/**
 * Restart reconciliation: what should be running on this VM, answered from
 * dispatch state rather than by replaying lifecycle events, plus the event
 * high-water marks the supervisor needs to resume its seq counter.
 */
export async function getAssignments(deps: Deps, agentId: string): Promise<Assignments> {
  const { rows: plans } = await deps.pool.query<{
    plan_id: string;
    state: string;
    project_id: string;
  }>(
    `SELECT id AS plan_id, state::text AS state, project_id FROM plans
      WHERE agent_id = $1 AND state NOT IN ('done', 'failed', 'rejected', 'cancelled')
      ORDER BY proposed_at`,
    [agentId],
  );

  const { rows: marks } = await deps.pool.query<{ stream_id: string; seq: number }>(
    `SELECT stream_id, MAX(seq) AS seq FROM events
      WHERE ingested_by = $1 GROUP BY stream_id ORDER BY stream_id`,
    [agentId],
  );

  return { plans, high_water_marks: marks };
}
