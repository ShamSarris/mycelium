import { validateEvent } from '@mycelium/contracts';
import type { PoolClient } from 'pg';
import type { Deps } from '../deps.js';
import { HttpError } from '../errors.js';
import { withTransaction } from '../db/pool.js';

export const MAX_BATCH = 500;

/**
 * Baseline section 7: no secret is ever written to an event payload. This
 * catches the obvious mistake at the boundary rather than discovering it in a
 * pg_dump months later.
 */
const SECRET_KEY = /token|secret|password|api[_-]?key/i;

export type EventType =
  | 'plan.state_changed'
  | 'task.state_changed'
  | 'task.dispatched'
  | 'task.lease_expired'
  | 'agent.model_call'
  | 'agent.tool_call'
  | 'sandbox.launched'
  | 'sandbox.exited'
  | 'limit.exceeded'
  | 'supervisor.heartbeat'
  | 'operator.action'
  | 'egress.allowed'
  | 'egress.denied'
  | 'environment.state_changed'
  | 'error';

export interface OrchestratorEvent {
  type: EventType;
  severity?: 'debug' | 'info' | 'warn' | 'error';
  projectId?: string | null;
  planId?: string | null;
  taskId?: string | null;
  payload?: Record<string, unknown>;
}

/**
 * Writes one orchestrator-sourced event. Always called on the same client as
 * the row change it describes, so a state change and its event commit together
 * or not at all.
 */
export async function recordEvent(
  client: PoolClient,
  deps: Deps,
  event: OrchestratorEvent,
): Promise<string> {
  const id = deps.newId();
  const now = deps.clock.now();

  await client.query(
    `INSERT INTO events
       (event_id, ts, received_at, source, stream_id, seq, type, severity,
        project_id, plan_id, task_id, ingested_by, payload)
     VALUES ($1, $2, $2, 'orchestrator', 'orchestrator', nextval('orchestrator_seq'),
             $3, $4, $5, $6, $7, NULL, $8)`,
    [
      id,
      now,
      event.type,
      event.severity ?? 'info',
      event.projectId ?? null,
      event.planId ?? null,
      event.taskId ?? null,
      JSON.stringify(event.payload ?? {}),
    ],
  );

  return id;
}

export interface IngestCaller {
  kind: 'supervisor' | 'agent';
  /** The supervisor that delivered the batch. For a plan token this is the plan's agent. */
  agentId: string | null;
  /** Set for a plan token: the only plan whose events this caller may post. */
  planId?: string;
}

export interface IngestResult {
  inserted: number;
  duplicates: number;
}

export async function ingestEvents(
  deps: Deps,
  caller: IngestCaller,
  body: unknown,
): Promise<IngestResult> {
  if (!Array.isArray(body)) {
    throw HttpError.badRequest('invalid_batch', 'expected an array of event envelopes');
  }
  if (body.length === 0) return { inserted: 0, duplicates: 0 };
  if (body.length > MAX_BATCH) {
    throw HttpError.badRequest('batch_too_large', `at most ${MAX_BATCH} events per request`);
  }

  const envelopes = body.map((candidate, index) => {
    const result = validateEvent(candidate);
    if (!result.ok) {
      throw HttpError.badRequest(
        'invalid_event',
        `event at index ${index} is not a valid envelope`,
        result.issues,
      );
    }
    return result.value;
  });

  // A supervisor may carry its agents' events as well as its own: the agent
  // emits over the local RPC socket and the supervisor spools to disk, which is
  // the only path that survives an orchestrator outage (baseline sections 4 and
  // 10). It may not carry them for a plan running somewhere else, so the plans
  // named by relayed events are checked against its placements.
  const relayedPlanIds = new Set<string>();

  for (const [index, envelope] of envelopes.entries()) {
    const relayed = caller.kind === 'supervisor' && envelope.source === 'agent';

    if (envelope.source !== caller.kind && !relayed) {
      throw HttpError.forbidden(
        `event at index ${index} claims source ${envelope.source}, but the caller is a ${caller.kind}`,
      );
    }
    if (relayed) {
      if (typeof envelope.plan_id !== 'string') {
        throw HttpError.forbidden(
          `event at index ${index} is relayed from an agent but names no plan`,
        );
      }
      relayedPlanIds.add(envelope.plan_id);
    }
    if (caller.planId !== undefined && envelope.plan_id !== caller.planId) {
      throw HttpError.forbidden(
        `event at index ${index} names a plan this token does not cover`,
      );
    }
    const payload = envelope.payload as Record<string, unknown> | undefined;
    if (payload) {
      const offending = Object.keys(payload).find((key) => SECRET_KEY.test(key));
      if (offending !== undefined) {
        throw HttpError.badRequest(
          'secret_in_payload',
          `event at index ${index} carries a payload key that looks like a secret: ${offending}`,
        );
      }
    }
  }

  if (relayedPlanIds.size > 0) {
    const ids = [...relayedPlanIds];
    const { rows } = await deps.pool.query<{ id: string }>(
      'SELECT id FROM plans WHERE id = ANY($1::uuid[]) AND agent_id = $2',
      [ids, caller.agentId],
    );
    const placed = new Set(rows.map((row) => row.id));
    const foreign = ids.find((id) => !placed.has(id));
    if (foreign !== undefined) {
      throw HttpError.forbidden(
        'the batch relays events for a plan that is not running on this supervisor',
      );
    }
  }

  // One transaction for the whole batch, so a supervisor's disk spool never
  // half-drains and leaves the operator guessing which half landed.
  return withTransaction(deps.pool, async (client) => {
    const now = deps.clock.now();
    let inserted = 0;

    for (const envelope of envelopes) {
      try {
        const { rowCount } = await client.query(
          `INSERT INTO events
             (event_id, ts, received_at, source, stream_id, seq, type, severity,
              project_id, plan_id, task_id, ingested_by, payload)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           ON CONFLICT (event_id) DO NOTHING`,
          [
            envelope.event_id,
            envelope.ts,
            now,
            envelope.source,
            envelope.stream_id,
            envelope.seq,
            envelope.type,
            envelope.severity ?? 'info',
            envelope.project_id ?? null,
            envelope.plan_id ?? null,
            envelope.task_id ?? null,
            caller.agentId,
            JSON.stringify(envelope.payload ?? {}),
          ],
        );
        inserted += rowCount ?? 0;
      } catch (error) {
        const code = (error as { code?: string }).code;
        const constraint = (error as { constraint?: string }).constraint;
        if (code === '23505' && constraint === 'events_stream_id_seq_key') {
          throw HttpError.conflict(
            'seq_reused',
            `stream ${envelope.stream_id} reused seq ${envelope.seq} for a different event`,
          );
        }
        throw error;
      }
    }

    return { inserted, duplicates: envelopes.length - inserted };
  });
}

export interface EventRow {
  event_id: string;
  ts: string;
  received_at: string;
  source: string;
  stream_id: string;
  seq: number;
  type: string;
  severity: string;
  project_id: string | null;
  plan_id: string | null;
  task_id: string | null;
  payload: Record<string, unknown>;
}

export interface EventQuery {
  planId: string;
  after?: string | undefined;
  limit?: number | undefined;
}

export async function queryEvents(deps: Deps, query: EventQuery): Promise<EventRow[]> {
  const limit = Math.min(Math.max(query.limit ?? 100, 1), MAX_BATCH);

  const columns = `event_id, ts, received_at, source, stream_id, seq, type, severity,
                   project_id, plan_id, task_id, payload`;

  if (query.after === undefined) {
    const { rows } = await deps.pool.query<EventRow>(
      `SELECT ${columns} FROM events
        WHERE plan_id = $1
        ORDER BY received_at, event_id
        LIMIT $2`,
      [query.planId, limit],
    );
    return rows;
  }

  // The cursor is an event_id; ordering is by (received_at, event_id), so the
  // cursor row's timestamp is needed to resume without skipping ties.
  const { rows: cursorRows } = await deps.pool.query<{ received_at: Date }>(
    'SELECT received_at FROM events WHERE event_id = $1',
    [query.after],
  );
  const cursor = cursorRows[0];
  if (!cursor) throw HttpError.badRequest('unknown_cursor', 'the after cursor names no event');

  const { rows } = await deps.pool.query<EventRow>(
    `SELECT ${columns} FROM events
      WHERE plan_id = $1 AND (received_at, event_id) > ($2, $3)
      ORDER BY received_at, event_id
      LIMIT $4`,
    [query.planId, cursor.received_at, query.after, limit],
  );
  return rows;
}
