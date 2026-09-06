import type { PlanRow } from '../services/plans.js';
import type { AgentRow } from '../services/supervisorsRegistry.js';
import type { HostMetrics } from '../domain/telemetry.js';

/**
 * What a page is allowed to see.
 *
 * `PLAN_COLUMNS` and `AGENT_COLUMNS` select the credential hashes because the
 * dispatcher needs them, so a row spread straight into a view model carries
 * them into a template — and the only thing catching that has been a test that
 * scans the rendered body for anything hash-shaped. That test is worth keeping,
 * but it has to be remembered once per page.
 *
 * These build a new object by naming fields instead, so the view types
 * structurally cannot hold a secret and a forgotten scan cannot leak one. It is
 * the same move `publicPlan` makes for the JSON routes
 * (`routes/operator.ts`); this is its half for the dashboard.
 *
 * Add a field here only after asking whether a page should render it.
 */

export interface PlanView {
  id: string;
  project_id: string;
  state: PlanRow['state'];
  env: 'dev' | 'prod';
  spec: PlanRow['spec'];
  proposed_at: Date;
  proposed_by: string;
  approved_at: Date | null;
  approved_by: string | null;
  agent_id: string | null;
  gitea_branch: string | null;
  provision_attempts: number;
  next_provision_at: Date | null;
  running_at: Date | null;
  ttl_expires_at: Date | null;
  manifest: unknown;
  terminal_reason: string | null;
  updated_at: Date;
}

export function viewPlan(row: PlanRow): PlanView {
  return {
    id: row.id,
    project_id: row.project_id,
    state: row.state,
    env: row.env,
    spec: row.spec,
    proposed_at: row.proposed_at,
    proposed_by: row.proposed_by,
    approved_at: row.approved_at,
    approved_by: row.approved_by,
    agent_id: row.agent_id,
    gitea_branch: row.gitea_branch,
    provision_attempts: row.provision_attempts,
    next_provision_at: row.next_provision_at,
    running_at: row.running_at,
    ttl_expires_at: row.ttl_expires_at,
    manifest: row.manifest,
    terminal_reason: row.terminal_reason,
    updated_at: row.updated_at,
  };
}

export interface AgentView {
  id: string;
  name: string;
  env: string;
  base_url: string;
  enabled: boolean;
  priority: number;
  last_heartbeat_at: Date | null;
  /** Already allowlisted by domain/telemetry.ts on the way into the column. */
  last_metrics: HostMetrics | null;
  /** Separate from the heartbeat, so alive-but-silent is visible as such. */
  last_metrics_at: Date | null;
  created_at: Date;
  healthy: boolean;
}

export function viewAgent(row: AgentRow & { healthy: boolean }): AgentView {
  return {
    id: row.id,
    name: row.name,
    env: row.env,
    base_url: row.base_url,
    enabled: row.enabled,
    priority: row.priority,
    last_heartbeat_at: row.last_heartbeat_at,
    last_metrics: row.last_metrics,
    last_metrics_at: row.last_metrics_at,
    created_at: row.created_at,
    healthy: row.healthy,
  };
}
