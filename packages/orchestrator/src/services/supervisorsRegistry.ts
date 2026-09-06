import type { Deps } from '../deps.js';
import { HttpError } from '../errors.js';
import { withTransaction } from '../db/pool.js';
import { isHealthy, type SupervisorCandidate } from '../domain/selection.js';
import { parseHostMetrics, type HostMetrics } from '../domain/telemetry.js';
import { recordEvent } from './events.js';
import { hashToken, mintToken } from '../tokens.js';

export interface AgentRow extends SupervisorCandidate {
  token_hash: string;
  created_at: Date;
  /** Whatever the supervisor last reported, already allowlisted on the way in. */
  last_metrics: HostMetrics | null;
  /** Deliberately not last_heartbeat_at: a VM can be alive and silent. */
  last_metrics_at: Date | null;
}

export const AGENT_COLUMNS = `id, name, env, base_url, token_hash, enabled, priority,
  last_heartbeat_at, last_metrics, last_metrics_at, created_at`;

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

/**
 * A heartbeat may carry a report on the machine the supervisor runs on. It is
 * optional in both directions: a supervisor that predates the telemetry sends
 * nothing, and a supervisor whose collector failed sends the heartbeat anyway
 * rather than lose its place in the dispatch rotation. So `metrics` being
 * absent is the normal case, never an error.
 */
export async function recordHeartbeat(
  deps: Deps,
  agentId: string,
  rawMetrics?: unknown,
): Promise<{ at: Date }> {
  const now = deps.clock.now();
  // Built from an allowlist, so a semi-trusted peer cannot write arbitrary
  // jsonb into a column the dashboard renders. See domain/telemetry.ts.
  const metrics = parseHostMetrics(rawMetrics);

  await withTransaction(deps.pool, async (client) => {
    // The two metric columns move together and only when there is something to
    // record: a silent heartbeat leaves the last real report and its age
    // alone, which is what makes alive-but-silent visible rather than looking
    // like fresh data.
    const { rowCount } = await client.query(
      `UPDATE agents
          SET last_heartbeat_at = $2,
              last_metrics      = coalesce($3::jsonb, last_metrics),
              last_metrics_at   = CASE WHEN $3::jsonb IS NULL THEN last_metrics_at ELSE $2 END
        WHERE id = $1`,
      [agentId, now, metrics === null ? null : JSON.stringify(metrics)],
    );
    if (rowCount === 0) throw HttpError.notFound('supervisor');

    // Stays {agent_id}. This fires every 30 seconds per VM into a table that
    // still has no retention policy (ticket 0008 section 8.3); the metrics
    // live on the agents row, where there is one of them rather than 2,880 a
    // day.
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
