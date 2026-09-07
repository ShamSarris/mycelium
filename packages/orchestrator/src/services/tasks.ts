import type { PoolClient } from 'pg';
import { withTransaction } from '../db/pool.js';
import type { Deps } from '../deps.js';
import { HttpError } from '../errors.js';
import { IllegalTransition, assertTaskTransition, type TaskState } from '../domain/states.js';
import { recordEvent } from './events.js';
import { notifyWake, recordPlanStateChange, recordTaskStateChange } from './state.js';
import { PLAN_COLUMNS, TASK_COLUMNS, type PlanRow, type TaskRow } from './plans.js';

export interface StatusReport {
  state: 'running' | 'done' | 'failed';
  /** Authoritative spend (D30). Both units are reported; cost drives the budget gate. */
  cost_spent_microusd?: number;
  /** Detail figure, kept beside the authoritative cost. */
  tokens_spent?: number;
  result?: unknown;
  error?: string;
}

function nonNegativeNumberField(candidate: Record<string, unknown>, field: string): number | undefined {
  const value = candidate[field];
  if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
    throw HttpError.badRequest('invalid_report', `${field} must be a non-negative number`);
  }
  return typeof value === 'number' ? value : undefined;
}

function parseReport(body: unknown): StatusReport {
  if (typeof body !== 'object' || body === null) {
    throw HttpError.badRequest('invalid_report', 'expected an object');
  }
  const candidate = body as Record<string, unknown>;
  const state = candidate.state;
  if (state !== 'running' && state !== 'done' && state !== 'failed') {
    throw HttpError.badRequest('invalid_report', 'state must be running, done, or failed');
  }
  const costMicrousd = nonNegativeNumberField(candidate, 'cost_spent_microusd');
  const tokens = nonNegativeNumberField(candidate, 'tokens_spent');
  const error = candidate.error;
  if (error !== undefined && typeof error !== 'string') {
    throw HttpError.badRequest('invalid_report', 'error must be a string');
  }

  const report: StatusReport = { state };
  if (typeof costMicrousd === 'number') report.cost_spent_microusd = costMicrousd;
  if (typeof tokens === 'number') report.tokens_spent = tokens;
  if (typeof error === 'string') report.error = error;
  if (candidate.result !== undefined) report.result = candidate.result;
  return report;
}

/**
 * The agent's only write path into task state (baseline section 5 step 6).
 * `dispatched -> running` is the acknowledgement that clears the lease.
 */
export async function reportTaskStatus(
  deps: Deps,
  input: { planId: string; taskId: string; body: unknown },
): Promise<{ task_id: string; state: TaskState }> {
  const report = parseReport(input.body);

  const outcome = await withTransaction(deps.pool, async (client) => {
    const plan = await lockPlan(client, input.planId);
    if (plan.state !== 'running') {
      throw HttpError.conflict('plan_not_running', `plan is ${plan.state}`);
    }

    const { rows } = await client.query<TaskRow>(
      `SELECT ${TASK_COLUMNS} FROM tasks WHERE id = $1 FOR UPDATE`,
      [input.taskId],
    );
    const task = rows[0];
    if (!task) throw HttpError.notFound('task');
    if (task.plan_id !== plan.id) {
      throw HttpError.forbidden('task belongs to another plan');
    }

    const now = deps.clock.now();

    if (report.state === 'running') {
      assertTransition(task.state, 'running');
      await client.query(
        `UPDATE tasks
            SET state = 'running', started_at = COALESCE(started_at, $2),
                lease_expires_at = NULL, updated_at = $2
          WHERE id = $1`,
        [task.id, now],
      );
      await recordTaskStateChange(client, deps, {
        planId: plan.id,
        taskId: task.id,
        from: task.state,
        to: 'running',
        reason: 'acknowledged',
      });
      return { task_id: task.id, state: 'running' as TaskState };
    }

    if (report.state === 'done') {
      assertTransition(task.state, 'done');
      await client.query(
        `UPDATE tasks
            SET state = 'done', finished_at = $2, updated_at = $2,
                tokens_spent = GREATEST(tokens_spent, $3),
                cost_spent_microusd = GREATEST(cost_spent_microusd, $5),
                result = $4,
                lease_expires_at = NULL
          WHERE id = $1`,
        [
          task.id,
          now,
          report.tokens_spent ?? 0,
          JSON.stringify(report.result ?? null),
          report.cost_spent_microusd ?? 0,
        ],
      );
      await recordTaskStateChange(client, deps, {
        planId: plan.id,
        taskId: task.id,
        from: task.state,
        to: 'done',
        reason: 'reported',
      });
      await promoteReadyTasks(client, deps, plan.id);
      await notifyWake(client);
      return { task_id: task.id, state: 'done' as TaskState };
    }

    const state = await applyFailure(client, deps, plan, task, report.error ?? 'reported_failure', {
      tokensSpent: report.tokens_spent ?? 0,
      costSpentMicrousd: report.cost_spent_microusd ?? 0,
    });
    await notifyWake(client);
    return { task_id: task.id, state };
  });

  return outcome;
}

function assertTransition(from: TaskState, to: TaskState): void {
  try {
    assertTaskTransition(from, to);
  } catch (error) {
    if (error instanceof IllegalTransition) {
      throw HttpError.conflict('illegal_transition', error.message);
    }
    throw error;
  }
}

/**
 * Applies the task's declared failure policy. Retry returns the task to `ready`
 * with the attempt counter advanced; anything terminal halts the plan, because
 * v1 has no non-blocking failure and continuing would only spend tokens on a
 * plan that can no longer satisfy `all_tasks_done`.
 */
export async function applyFailure(
  client: PoolClient,
  deps: Deps,
  plan: PlanRow,
  task: TaskRow,
  reason: string,
  options: { tokensSpent?: number; costSpentMicrousd?: number; costUnknown?: boolean } = {},
): Promise<TaskState> {
  const now = deps.clock.now();
  const policy = task.spec.failure_policy ?? { type: 'halt' as const };
  const attempt = task.execution_attempt + 1;
  const canRetry = !options.costUnknown && policy.type === 'retry' && attempt < policy.max_attempts;

  if (canRetry) {
    await client.query(
      `UPDATE tasks
          SET state = 'ready', execution_attempt = $2, error = $3, updated_at = $4,
              lease_expires_at = NULL, dispatch_id = NULL, started_at = NULL,
              tokens_spent = GREATEST(tokens_spent, $5),
              cost_spent_microusd = GREATEST(cost_spent_microusd, $6)
        WHERE id = $1`,
      [task.id, attempt, reason, now, options.tokensSpent ?? 0, options.costSpentMicrousd ?? 0],
    );
    await recordTaskStateChange(client, deps, {
      planId: plan.id,
      taskId: task.id,
      from: task.state,
      to: 'ready',
      reason: `retry_${attempt}_of_${policy.max_attempts}`,
    });
    return 'ready';
  }

  await client.query(
    `UPDATE tasks
        SET state = 'failed', finished_at = $2, error = $3, updated_at = $2,
            execution_attempt = $4, lease_expires_at = NULL,
            tokens_spent = GREATEST(tokens_spent, $5),
            cost_spent_microusd = GREATEST(cost_spent_microusd, $6)
      WHERE id = $1`,
    [task.id, now, reason, attempt, options.tokensSpent ?? 0, options.costSpentMicrousd ?? 0],
  );
  await recordTaskStateChange(client, deps, {
    planId: plan.id,
    taskId: task.id,
    from: task.state,
    to: 'failed',
    reason,
  });

  await haltPlan(client, deps, plan, reason);
  return 'failed';
}

/**
 * A terminal task failure aborts the plan: siblings are cancelled and the plan
 * moves to finalizing so a manifest is still written.
 */
export async function haltPlan(
  client: PoolClient,
  deps: Deps,
  plan: PlanRow,
  reason: string,
): Promise<void> {
  const now = deps.clock.now();

  const { rows: openTasks } = await client.query<{ id: string; state: TaskState }>(
    `SELECT id, state FROM tasks
      WHERE plan_id = $1 AND state NOT IN ('done', 'failed', 'cancelled')
      FOR UPDATE`,
    [plan.id],
  );

  await client.query(
    `UPDATE tasks SET state = 'cancelled', finished_at = $2, updated_at = $2
      WHERE plan_id = $1 AND state NOT IN ('done', 'failed', 'cancelled')`,
    [plan.id, now],
  );

  for (const task of openTasks) {
    await recordTaskStateChange(client, deps, {
      planId: plan.id,
      taskId: task.id,
      from: task.state,
      to: 'cancelled',
      reason: 'plan_halted',
    });
  }

  await client.query(
    `UPDATE plans SET state = 'finalizing', terminal_reason = $2, updated_at = $3
      WHERE id = $1 AND state = 'running'`,
    [plan.id, `task_failed:${reason}`, now],
  );
  await recordPlanStateChange(client, deps, {
    planId: plan.id,
    projectId: plan.project_id,
    from: 'running',
    to: 'finalizing',
    reason: 'halt',
  });
}

/**
 * A task is ready when every dependency is done and the plan is running.
 * Also run from the dispatcher tick, so a missed promotion self-heals.
 */
export async function promoteReadyTasks(
  client: PoolClient,
  deps: Deps,
  planId: string,
): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `UPDATE tasks SET state = 'ready', updated_at = $2
      WHERE plan_id = $1
        AND state = 'pending'
        AND EXISTS (SELECT 1 FROM plans p WHERE p.id = tasks.plan_id AND p.state = 'running')
        AND NOT EXISTS (
          SELECT 1 FROM task_dependencies d
            JOIN tasks dep ON dep.id = d.depends_on_task_id
           WHERE d.task_id = tasks.id AND dep.state <> 'done'
        )
      RETURNING id`,
    [planId, deps.clock.now()],
  );

  for (const row of rows) {
    await recordTaskStateChange(client, deps, {
      planId,
      taskId: row.id,
      from: 'pending',
      to: 'ready',
      reason: 'dependencies_satisfied',
    });
  }

  return rows.map((r) => r.id);
}

/** Transport recovery: a dispatch the agent never acknowledged returns to the queue. */
export async function expireLeases(deps: Deps): Promise<string[]> {
  return withTransaction(deps.pool, async (client) => {
    const now = deps.clock.now();
    const { rows } = await client.query<{ id: string; plan_id: string }>(
      `UPDATE tasks SET state = 'ready', lease_expires_at = NULL, dispatch_id = NULL, updated_at = $1
        WHERE state = 'dispatched' AND lease_expires_at IS NOT NULL AND lease_expires_at < $1
        RETURNING id, plan_id`,
      [now],
    );

    for (const row of rows) {
      await recordEvent(client, deps, {
        type: 'task.lease_expired',
        severity: 'warn',
        planId: row.plan_id,
        taskId: row.id,
        payload: { reason: 'lease_expired' },
      });
      await recordTaskStateChange(client, deps, {
        planId: row.plan_id,
        taskId: row.id,
        from: 'dispatched',
        to: 'ready',
        reason: 'lease_expired',
      });
    }

    return rows.map((r) => r.id);
  });
}

/**
 * A running task that stops reporting is failed once it passes its declared
 * wall-clock cap plus a grace period, then handled by its failure policy.
 */
export async function enforceWallClock(deps: Deps): Promise<string[]> {
  const graceMs = deps.config.wallClockGraceMinutes * 60_000;

  // Scanned without locks, then re-read under a plan-then-task lock. Every
  // writer takes those two in that order, so concurrent ticks cannot deadlock.
  const { rows: candidates } = await deps.pool.query<{ id: string; plan_id: string }>(
    `SELECT id, plan_id FROM tasks WHERE state = 'running' AND started_at IS NOT NULL`,
  );

  const expired: string[] = [];

  for (const candidate of candidates) {
    const didExpire = await withTransaction(deps.pool, async (client) => {
      const plan = await lockPlan(client, candidate.plan_id);
      if (plan.state !== 'running') return false;

      const { rows } = await client.query<TaskRow>(
        `SELECT ${TASK_COLUMNS} FROM tasks WHERE id = $1 FOR UPDATE`,
        [candidate.id],
      );
      const task = rows[0];
      if (!task || task.state !== 'running' || task.started_at === null) return false;

      const now = deps.clock.now();
      const capMs = task.spec.limits.wall_clock_min * 60_000 + graceMs;
      if (now.getTime() - task.started_at.getTime() < capMs) return false;

      await recordEvent(client, deps, {
        type: 'limit.exceeded',
        severity: 'warn',
        planId: plan.id,
        taskId: task.id,
        payload: { limit: 'wall_clock_min', value: task.spec.limits.wall_clock_min },
      });
      await applyFailure(client, deps, plan, task, 'wall_clock_exceeded');
      return true;
    });

    if (didExpire) expired.push(candidate.id);
  }

  return expired;
}

export async function lockPlan(client: PoolClient, planId: string): Promise<PlanRow> {
  const { rows } = await client.query<PlanRow>(
    `SELECT ${PLAN_COLUMNS} FROM plans WHERE id = $1 FOR UPDATE`,
    [planId],
  );
  const plan = rows[0];
  if (!plan) throw HttpError.notFound('plan');
  return plan;
}
