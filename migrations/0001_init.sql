-- 0001_init.sql — control plane for Mycelium v1.
--
-- Covers baseline section 6: projects, plans, tasks, task_dependencies, agents,
-- and the append-only events log. Roll-forward only; a mistake here is corrected
-- by the next migration, never by a down-migration.

CREATE TYPE env_kind AS ENUM ('dev', 'prod');

CREATE TYPE plan_state AS ENUM (
  'proposed',
  'queued',
  'provisioning',
  'running',
  'finalizing',
  'done',
  'failed',
  'rejected',
  'cancelled'
);

CREATE TYPE task_state AS ENUM (
  'pending',
  'ready',
  'dispatched',
  'running',
  'done',
  'failed',
  'cancelled'
);

CREATE TYPE event_source AS ENUM ('orchestrator', 'supervisor', 'agent');

CREATE TYPE event_severity AS ENUM ('debug', 'info', 'warn', 'error');

-- Every orchestrator-emitted event draws its seq from here. One stream
-- ("orchestrator"), so one sequence is enough to keep seq monotonic.
CREATE SEQUENCE orchestrator_seq;

CREATE TABLE projects (
  id          uuid PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  gitea_repo  text,
  created_at  timestamptz NOT NULL
);

-- A registered node supervisor. The table is named `agents` because the baseline
-- names it that; it holds exactly what placement needs (baseline section 6).
CREATE TABLE agents (
  id                uuid PRIMARY KEY,
  name              text NOT NULL UNIQUE,
  env               env_kind NOT NULL,
  base_url          text NOT NULL,
  token_hash        text NOT NULL,
  enabled           boolean NOT NULL DEFAULT true,
  priority          integer NOT NULL DEFAULT 100,
  last_heartbeat_at timestamptz,
  created_at        timestamptz NOT NULL
);

CREATE TABLE plans (
  id                  uuid PRIMARY KEY,
  project_id          uuid NOT NULL REFERENCES projects (id),
  state               plan_state NOT NULL,
  env                 env_kind NOT NULL,
  -- The validated plan document with schema defaults filled in.
  spec                jsonb NOT NULL,
  proposed_at         timestamptz NOT NULL,
  proposed_by         text NOT NULL,
  approved_at         timestamptz,
  approved_by         text,
  -- Sticky for the life of the plan: there is no mid-plan rescheduling (B12).
  agent_id            uuid REFERENCES agents (id),
  -- Hash only. The plaintext per-plan token lives in orchestrator memory between
  -- approval and dispatch and is re-minted after a restart (baseline section 7).
  agent_token_hash    text,
  gitea_branch        text,
  gitea_bot_token_ref text,
  provision_attempts  integer NOT NULL DEFAULT 0,
  next_provision_at   timestamptz,
  running_at          timestamptz,
  ttl_expires_at      timestamptz,
  manifest            jsonb,
  terminal_reason     text,
  updated_at          timestamptz NOT NULL
);

CREATE TABLE tasks (
  id                uuid PRIMARY KEY,
  plan_id           uuid NOT NULL REFERENCES plans (id),
  -- The plan-local task id from plan.json, distinct from this row's uuid.
  local_id          text NOT NULL,
  state             task_state NOT NULL,
  spec              jsonb NOT NULL,
  execution_attempt integer NOT NULL DEFAULT 0,
  dispatch_attempt  integer NOT NULL DEFAULT 0,
  dispatch_id       uuid,
  lease_expires_at  timestamptz,
  started_at        timestamptz,
  finished_at       timestamptz,
  tokens_spent      integer NOT NULL DEFAULT 0,
  result            jsonb,
  error             text,
  updated_at        timestamptz NOT NULL,
  UNIQUE (plan_id, local_id)
);

CREATE TABLE task_dependencies (
  task_id            uuid NOT NULL REFERENCES tasks (id),
  depends_on_task_id uuid NOT NULL REFERENCES tasks (id),
  PRIMARY KEY (task_id, depends_on_task_id)
);

CREATE TABLE events (
  -- Minted by the emitter. The idempotency key for spool replay.
  event_id    uuid PRIMARY KEY,
  ts          timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  source      event_source NOT NULL,
  stream_id   text NOT NULL,
  seq         bigint NOT NULL,
  type        text NOT NULL,
  severity    event_severity NOT NULL DEFAULT 'info',
  project_id  uuid,
  plan_id     uuid,
  task_id     uuid,
  -- Which registered supervisor delivered this event, for restart reconciliation.
  -- Null for orchestrator-emitted events.
  ingested_by uuid REFERENCES agents (id),
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (stream_id, seq)
);

CREATE INDEX tasks_plan_state_idx ON tasks (plan_id, state);
CREATE INDEX tasks_lease_idx ON tasks (lease_expires_at) WHERE state = 'dispatched';
CREATE INDEX events_plan_ts_idx ON events (plan_id, received_at, event_id);
CREATE INDEX events_ingested_by_idx ON events (ingested_by, stream_id);
CREATE INDEX plans_state_idx ON plans (state);
CREATE INDEX task_dependencies_depends_on_idx ON task_dependencies (depends_on_task_id);

-- The event log is append-only (goal G4). Enforced here rather than by convention,
-- because a silent rewrite of history is the one bug the log cannot help debug.
-- TRUNCATE does not fire row-level triggers, so test teardown still works.
CREATE FUNCTION events_are_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'events is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER events_append_only
  BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION events_are_append_only();
