import { withTransaction } from '../db/pool.js';
import type { Deps } from '../deps.js';
import { HttpError } from '../errors.js';
import { ALERT_EVENT_TYPES, isAlert } from '../domain/alerts.js';
import { recordEvent } from './events.js';

/**
 * The alert list, and clearing an entry from it.
 *
 * There is no alerts table. The list is `domain/alerts.ts`'s rule applied to
 * the event log, minus what has been acknowledged — so an alert cannot drift
 * from the event it describes, because it is not a separate record of it.
 *
 * This is also the only cross-plan read of `events` in the system. Every other
 * view is scoped to a plan, which is right for a timeline and useless for the
 * thing you check when you do not yet know what broke.
 */

export interface AlertRow {
  event_id: string;
  ts: Date;
  source: string;
  type: string;
  severity: string;
  project_id: string | null;
  plan_id: string | null;
  task_id: string | null;
  payload: Record<string, unknown>;
}

/** A page of the log wide enough that the rule can discard from it and still fill a screen. */
const SCAN_LIMIT = 500;

export async function listAlerts(deps: Deps, limit = 50): Promise<AlertRow[]> {
  // The SQL prefilters on what the index covers — severity, and the two warn
  // types worth a second look — and the rule decides the rest. Splitting it
  // this way keeps the interesting half readable and testable without a
  // database, at the cost of fetching some rows that are then discarded.
  const { rows } = await deps.pool.query<AlertRow>(
    `SELECT e.event_id, e.ts, e.source, e.type, e.severity,
            e.project_id, e.plan_id, e.task_id, e.payload
       FROM events e
       LEFT JOIN alert_acknowledgements a ON a.event_id = e.event_id
      WHERE a.event_id IS NULL
        AND (e.severity = 'error' OR (e.severity = 'warn' AND e.type = ANY($1)))
      ORDER BY e.received_at DESC, e.event_id DESC
      LIMIT $2`,
    [[...ALERT_EVENT_TYPES], SCAN_LIMIT],
  );

  return rows.filter((row) => isAlert(row)).slice(0, limit);
}

export interface AcknowledgeInput {
  eventId: string;
  operator: string;
}

export async function acknowledgeAlert(
  deps: Deps,
  input: AcknowledgeInput,
): Promise<{ event_id: string }> {
  return withTransaction(deps.pool, async (client) => {
    const { rows } = await client.query<{
      type: string;
      severity: string;
      payload: Record<string, unknown>;
      plan_id: string | null;
      project_id: string | null;
    }>(
      'SELECT type, severity, payload, plan_id, project_id FROM events WHERE event_id = $1',
      [input.eventId],
    );

    const event = rows[0];
    // An event that was never an alert is a 404 rather than a quiet success:
    // writing the row would leave something nothing reads and imply the list
    // had held it.
    if (!event || !isAlert(event)) throw HttpError.notFound('alert');

    await client.query(
      `INSERT INTO alert_acknowledgements (event_id, acknowledged_at, acknowledged_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (event_id) DO NOTHING`,
      [input.eventId, deps.clock.now(), input.operator],
    );

    // Every operator mutation is attributed and recorded, this one included.
    await recordEvent(client, deps, {
      type: 'operator.action',
      ...(event.plan_id === null ? {} : { planId: event.plan_id }),
      payload: {
        action: 'acknowledge_alert',
        operator: input.operator,
        event_id: input.eventId,
        alert_type: event.type,
      },
    });

    return { event_id: input.eventId };
  });
}
