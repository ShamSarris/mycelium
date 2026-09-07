import { looksLikeSecretKey, validateEvent } from '@mycelium/contracts';
import type { PoolClient } from 'pg';
import type { Deps } from '../deps.js';
import { HttpError } from '../errors.js';
import { withTransaction } from '../db/pool.js';

export const MAX_BATCH = 500;

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
      // Baseline section 7: no secret is ever written to an event payload.
      // The rule is shared with the supervisor's emit guard so the two cannot
      // drift; see packages/contracts/src/secrets.ts.
      const offending = Object.keys(payload).find(looksLikeSecretKey);
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

/**
 * Subagent activity for one plan.
 *
 * A separate query rather than a fold over the plan page's own event window,
 * which is the oldest 50 rows: a subagent section built on that window would
 * go blank on exactly the long-running plan it exists to explain.
 *
 * Everything here rides `agent.tool_call` under a `phase` key, because the
 * agent may emit only four event types and the event schema's enum is closed
 * — `packages/worker/src/runner/subagents.ts` carries the reasoning and the
 * payload shapes. Nothing in this module validates those payloads: they are
 * written by a semi-trusted agent, so every field is treated as unknown text
 * and escaped at render.
 */
export interface SubagentDefinition {
  name: string;
  description: string;
  prompt: string;
  tools: string[];
  effort: string;
}

export interface SubagentRun {
  id: string;
  type: string;
  running: boolean;
  startedAt: Date | null;
  durationMs: number | null;
  lastMessage: string | null;
  toolCalls: number;
}

export interface SubagentActivity {
  /** What the agent announced it was configured with, or empty if it never said. */
  roster: SubagentDefinition[];
  runs: SubagentRun[];
}

const LIFECYCLE_PHASES = ['subagent_roster', 'subagent_start', 'subagent_stop'];

/** Enough for a long plan; a run that spawns more than this is its own problem. */
const SUBAGENT_EVENT_LIMIT = 500;

export async function subagentActivity(deps: Deps, planId: string): Promise<SubagentActivity> {
  const [lifecycle, counts] = await Promise.all([
    deps.pool.query<{ ts: Date; payload: Record<string, unknown> }>(
      `SELECT ts, payload FROM events
        WHERE plan_id = $1 AND type = 'agent.tool_call'
          AND payload->>'phase' = ANY($2)
        ORDER BY received_at, event_id
        LIMIT ${SUBAGENT_EVENT_LIMIT}`,
      [planId, LIFECYCLE_PHASES],
    ),
    // Counted in the database rather than folded from rows: a subagent's tool
    // calls are the one thing here that scales with the length of the run.
    // `phase IS NULL` excludes the lifecycle events, which carry the same
    // `subagent_id` and would otherwise inflate every count by two.
    deps.pool.query<{ subagent_id: string; calls: string }>(
      `SELECT payload->>'subagent_id' AS subagent_id, count(*)::bigint AS calls
         FROM events
        WHERE plan_id = $1 AND type = 'agent.tool_call'
          AND payload->>'subagent_id' IS NOT NULL
          AND payload->>'phase' IS NULL
        GROUP BY 1`,
      [planId],
    ),
  ]);

  // `pg` returns a bigint aggregate as a string, always.
  const toolCalls = new Map(counts.rows.map((row) => [row.subagent_id, Number(row.calls)]));

  let roster: SubagentDefinition[] = [];
  const runs = new Map<string, SubagentRun>();

  for (const { ts, payload } of lifecycle.rows) {
    const phase = String(payload.phase);

    if (phase === 'subagent_roster') {
      // Last announcement wins: a task retried after a redeploy announces
      // again, and the newer one describes the agent that is actually running.
      roster = readRoster(payload.subagents);
      continue;
    }

    const id = typeof payload.subagent_id === 'string' ? payload.subagent_id : null;
    if (id === null) continue;
    const type = typeof payload.subagent_type === 'string' ? payload.subagent_type : 'unknown';

    if (phase === 'subagent_start') {
      runs.set(id, {
        id,
        type,
        running: true,
        startedAt: ts,
        durationMs: null,
        lastMessage: null,
        toolCalls: toolCalls.get(id) ?? 0,
      });
      continue;
    }

    // A stop with no start: the events either arrived out of order or the
    // start was lost. Reporting the stop alone beats dropping it.
    const existing = runs.get(id);
    runs.set(id, {
      id,
      type,
      running: false,
      startedAt: existing?.startedAt ?? null,
      durationMs: typeof payload.duration_ms === 'number' ? payload.duration_ms : null,
      lastMessage: typeof payload.last_message === 'string' ? payload.last_message : null,
      toolCalls: toolCalls.get(id) ?? 0,
    });
  }

  // Still running first, then most recently started: what is happening now is
  // what an operator opened this page to see.
  const ordered = [...runs.values()].sort((a, b) => {
    if (a.running !== b.running) return a.running ? -1 : 1;
    return (b.startedAt?.getTime() ?? 0) - (a.startedAt?.getTime() ?? 0);
  });

  return { roster, runs: ordered };
}

/** The roster as the agent sent it. Every field is unknown until proven otherwise. */
function readRoster(value: unknown): SubagentDefinition[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const spec = entry as Record<string, unknown>;
    if (typeof spec.name !== 'string') return [];

    return [
      {
        name: spec.name,
        description: typeof spec.description === 'string' ? spec.description : '',
        prompt: typeof spec.prompt === 'string' ? spec.prompt : '',
        tools: Array.isArray(spec.tools) ? spec.tools.map(String) : [],
        effort: typeof spec.effort === 'string' ? spec.effort : 'unknown',
      },
    ];
  });
}
