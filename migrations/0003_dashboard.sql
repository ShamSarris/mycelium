-- Current value only, no history. A history table would take ~2,880 rows per
-- VM per day into a database that still has no retention policy (ticket 0008
-- section 8.3), to answer a question — "what did this VM look like an hour
-- ago" — that nothing asks yet. The `supervisor.heartbeat` event payload stays
-- `{agent_id}` for the same reason.
--
-- The shape is decided in src/domain/telemetry.ts, not here: a supervisor is a
-- semi-trusted peer, and jsonb will store whatever it is handed.
ALTER TABLE agents
  ADD COLUMN last_metrics    jsonb,
  -- Separate from last_heartbeat_at on purpose. A supervisor that predates
  -- this migration heartbeats normally and reports nothing, and the operator
  -- must be able to tell that alive-but-silent from dead.
  ADD COLUMN last_metrics_at timestamptz;

-- The project page lists one project's plans, newest first. Without this it is
-- a sequential scan of every plan in the system to render one project.
CREATE INDEX plans_project_idx ON plans (project_id, proposed_at DESC);

-- The servers page names the plans placed on each VM, which is the only thing
-- that makes an unhealthy row actionable. Partial because an unplaced plan can
-- never match, and most rows in a healthy system are terminal.
CREATE INDEX plans_agent_idx ON plans (agent_id) WHERE agent_id IS NOT NULL;

-- Every plan listing orders by this, and the monitor page windows on it.
CREATE INDEX plans_proposed_at_idx ON plans (proposed_at DESC);
