import type { Deps } from '../deps.js';

/**
 * The aggregates behind the Monitor page.
 *
 * Two things shape every query here. Each one names the timestamp it is a
 * window over — spend is keyed on `tasks.finished_at`, because nothing in the
 * schema timestamps token spend and that is the nearest honest key — and none
 * of them touches `events(type)`, which has no index: `events` is the
 * fastest-growing table in the system and still has no retention policy
 * (ticket 0008 section 8.3). Indexing it is a decision about retention, not
 * about a dashboard.
 */

/** The three windows the page offers. Anything else is a bookmark, not a request. */
export const WINDOW_DAYS = [1, 7, 30] as const;
export type WindowDays = (typeof WINDOW_DAYS)[number];
export const DEFAULT_WINDOW: WindowDays = 7;

/**
 * A bad `days` is a stale link or a typo, so it falls back rather than 400ing:
 * the operator asked for the monitor, and the monitor has a sane default.
 */
export function parseWindowDays(raw: unknown): WindowDays {
  const value = Number(raw);
  return (WINDOW_DAYS as readonly number[]).includes(value)
    ? (value as WindowDays)
    : DEFAULT_WINDOW;
}

export interface StateCount {
  state: string;
  n: number;
}

export interface TaskOutcome extends StateCount {
  tokens: number;
  /** Summed re-executions and re-dispatches, which are two different failures. */
  executions: number;
  dispatches: number;
}

export interface DaySpend {
  /** UTC, so the buckets do not move with the server's timezone. */
  day: string;
  tokens: number;
}

export interface FailedPlan {
  id: string;
  goal: string | null;
  state: string;
  terminal_reason: string | null;
  provision_attempts: number;
  updated_at: Date;
}

export interface Latency {
  task_p50: number | null;
  task_p95: number | null;
  approval_p50: number | null;
  approval_p95: number | null;
}

export interface MonitorSummary {
  days: WindowDays;
  since: Date;
  plans: StateCount[];
  tasks: TaskOutcome[];
  spend: DaySpend[];
  failures: FailedPlan[];
  events: StateCount[];
  latency: Latency;
  /** Plans waiting on a decision, for the tab badge every page carries. */
  proposed: number;
}

/** Enough failures to see a pattern; more than that is the plan list's job. */
const FAILURE_LIMIT = 20;

export async function monitorSummary(deps: Deps, days: WindowDays): Promise<MonitorSummary> {
  const since = new Date(deps.clock.now().getTime() - days * 86_400_000);

  const [plans, tasks, spend, failures, events, latency, proposed] = await Promise.all([
    // Plans *proposed* in the window, by the state they are in now. Not a
    // funnel: a plan proposed on day one and finished on day three is counted
    // once, as done.
    deps.pool.query<StateCount>(
      `SELECT state::text AS state, count(*)::int AS n
         FROM plans WHERE proposed_at >= $1 GROUP BY state ORDER BY state`,
      [since],
    ),

    // Finished tasks only: an unfinished task has no outcome, and counting it
    // as one would make every long-running plan look like a stall.
    deps.pool.query<TaskOutcome>(
      `SELECT state::text AS state, count(*)::int AS n,
              coalesce(sum(tokens_spent), 0)::int AS tokens,
              coalesce(sum(execution_attempt), 0)::int AS executions,
              coalesce(sum(dispatch_attempt), 0)::int AS dispatches
         FROM tasks WHERE finished_at >= $1 GROUP BY state ORDER BY state`,
      [since],
    ),

    deps.pool.query<DaySpend>(
      `SELECT to_char(date_trunc('day', finished_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
              coalesce(sum(tokens_spent), 0)::int AS tokens
         FROM tasks WHERE finished_at >= $1 GROUP BY 1 ORDER BY 1`,
      [since],
    ),

    // Named columns rather than PLAN_COLUMNS: this is a page, and PLAN_COLUMNS
    // carries two credential fields it must never see.
    deps.pool.query<FailedPlan>(
      `SELECT id, spec->>'goal' AS goal, state::text AS state, terminal_reason,
              provision_attempts, updated_at
         FROM plans
        WHERE state IN ('failed', 'cancelled') AND updated_at >= $1
        ORDER BY updated_at DESC LIMIT ${FAILURE_LIMIT}`,
      [since],
    ),

    // A superset of the alert list: `isAlert` filters warn events on their
    // payload, which cannot be expressed in a GROUP BY, so this counts every
    // warn and error and is labelled as exactly that. It rides
    // `events_alerts_idx`, which covers the same severities.
    deps.pool.query<StateCount>(
      `SELECT type AS state, count(*)::int AS n
         FROM events
        WHERE received_at >= $1 AND severity IN ('warn', 'error')
        GROUP BY type ORDER BY n DESC, type`,
      [since],
    ),

    // `percentile_disc` returns a value that actually occurred rather than an
    // interpolation between two that did — with a handful of tasks a week,
    // an invented midpoint would be the wrong kind of precision.
    deps.pool.query<Latency>(
      `SELECT
         (SELECT percentile_disc(0.5) WITHIN GROUP (
            ORDER BY extract(epoch FROM (finished_at - started_at)))
            FROM tasks WHERE finished_at >= $1 AND started_at IS NOT NULL)::int AS task_p50,
         (SELECT percentile_disc(0.95) WITHIN GROUP (
            ORDER BY extract(epoch FROM (finished_at - started_at)))
            FROM tasks WHERE finished_at >= $1 AND started_at IS NOT NULL)::int AS task_p95,
         (SELECT percentile_disc(0.5) WITHIN GROUP (
            ORDER BY extract(epoch FROM (approved_at - proposed_at)))
            FROM plans WHERE approved_at >= $1)::int AS approval_p50,
         (SELECT percentile_disc(0.95) WITHIN GROUP (
            ORDER BY extract(epoch FROM (approved_at - proposed_at)))
            FROM plans WHERE approved_at >= $1)::int AS approval_p95`,
      [since],
    ),

    // Not windowed: a plan proposed five weeks ago is still waiting on you.
    deps.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM plans WHERE state = 'proposed'`,
    ),
  ]);

  return {
    days,
    since,
    plans: plans.rows,
    tasks: tasks.rows,
    spend: spend.rows,
    failures: failures.rows,
    events: events.rows,
    latency: latency.rows[0] ?? {
      task_p50: null,
      task_p95: null,
      approval_p50: null,
      approval_p95: null,
    },
    proposed: proposed.rows[0]?.n ?? 0,
  };
}
