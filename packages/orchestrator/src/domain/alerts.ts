/**
 * What counts as an alert.
 *
 * An alert is something that **already happened and will never resurface on
 * its own**, which is what separates it from the needs-attention queue. A plan
 * in `proposed` is waiting and clears by approving it; a TTL auto-fail or an
 * event-spool overflow leaves nothing in a waiting state and is simply gone if
 * nobody looks. Several requirements across this system end with "alerts the
 * operator" and nothing delivered that until now.
 *
 * An alert is a **view of an event**, never a copy of one. There is no alerts
 * table: the list is this rule applied to `events`, left-joined to the
 * acknowledgements. That is what makes "an alert is never the only record"
 * true by construction rather than by discipline, and it means changing this
 * rule is a code change rather than a backfill.
 */

/**
 * The `warn`-severity types worth a second look. Kept as data because the SQL
 * prefilters on it: if the two drift, an alert either never appears or is
 * fetched and then discarded.
 */
export const ALERT_EVENT_TYPES = new Set(['limit.exceeded', 'environment.state_changed']);

/** The `environment.state_changed` reasons that mean something ended badly. */
const ALERT_REASONS = new Set(['orphan_after_restart', 'ttl_expired']);

export interface AlertCandidate {
  type: string;
  severity: string;
  payload: unknown;
}

export function isAlert(event: AlertCandidate): boolean {
  // Anything a service called an error is an error. The three services agree
  // on severity even though they do not agree on payload shapes.
  if (event.severity === 'error') return true;
  if (event.severity !== 'warn') return false;

  // Payloads are untyped in v1 and come from three sources, so this must
  // tolerate one it did not expect rather than throwing inside a query.
  const payload =
    typeof event.payload === 'object' && event.payload !== null
      ? (event.payload as Record<string, unknown>)
      : {};

  if (event.type === 'limit.exceeded') {
    // A task's own ceiling is the failure policy's business and shows on the
    // plan. A *plan's* ceiling stopped everything and nothing else will say so.
    return payload.limit === 'plan_cost';
  }

  if (event.type === 'environment.state_changed') {
    return typeof payload.reason === 'string' && ALERT_REASONS.has(payload.reason);
  }

  return false;
}
