-- Alerts are a view of the event log, not a copy of it: the list is a rule
-- applied to `events` (see src/domain/alerts.ts), and this table records only
-- which of them the operator has dealt with. Keeping it that way is what makes
-- "an alert is never the only record" true by construction — there is no
-- second row that can disagree with the first, and changing which events
-- qualify is a code change rather than a backfill.
CREATE TABLE alert_acknowledgements (
  event_id        uuid PRIMARY KEY REFERENCES events (event_id),
  acknowledged_at timestamptz NOT NULL,
  -- The Serve-injected operator login. Attribution, same as every other
  -- mutation; the audit trail is the `operator.action` event beside it.
  acknowledged_by text NOT NULL
);

-- The alert query is the only cross-plan read of the event table, and it filters
-- on severity and type rather than on plan_id, so events_plan_ts_idx does not
-- help it. Partial, because alerts are a tiny fraction of a log that also
-- carries every tool call.
CREATE INDEX events_alerts_idx
  ON events (received_at DESC, event_id)
  WHERE severity IN ('warn', 'error');
