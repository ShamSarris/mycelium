import { validatePlan, type Plan } from '@mycelium/contracts';
import type { PoolClient } from 'pg';
import { withTransaction } from '../db/pool.js';
import type { Deps } from '../deps.js';
import { HttpError } from '../errors.js';
import { isPlanTerminal, type PlanState, type TaskState } from '../domain/states.js';
import { recordEvent } from './events.js';
import { notifyWake, recordPlanStateChange, recordTaskStateChange } from './state.js';
import { hashToken, mintToken } from '../tokens.js';

export interface PlanRow {
  id: string;
  project_id: string;
  state: PlanState;
  env: 'dev' | 'prod';
  spec: Plan;
  proposed_at: Date;
  proposed_by: string;
  approved_at: Date | null;
  approved_by: string | null;
  agent_id: string | null;
  agent_token_hash: string | null;
  gitea_branch: string | null;
  gitea_bot_token_ref: string | null;
  provision_attempts: number;
  next_provision_at: Date | null;
  running_at: Date | null;
  ttl_expires_at: Date | null;
  manifest: unknown;
  terminal_reason: string | null;
  updated_at: Date;
}

export interface TaskRow {
  id: string;
  plan_id: string;
  local_id: string;
  state: TaskState;
  spec: Plan['tasks'][number];
  execution_attempt: number;
  dispatch_attempt: number;
  dispatch_id: string | null;
  lease_expires_at: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
  tokens_spent: number;
  /** bigint in Postgres; parsed from the string `pg` returns in `listTasks`. */
  cost_spent_microusd: number;
  result: unknown;
  error: string | null;
  updated_at: Date;
}

export const PLAN_COLUMNS = `id, project_id, state, env, spec, proposed_at, proposed_by,
  approved_at, approved_by, agent_id, agent_token_hash, gitea_branch, gitea_bot_token_ref,
  provision_attempts, next_provision_at, running_at, ttl_expires_at, manifest,
  terminal_reason, updated_at`;

export const TASK_COLUMNS = `id, plan_id, local_id, state, spec, execution_attempt,
  dispatch_attempt, dispatch_id, lease_expires_at, started_at, finished_at, tokens_spent,
  cost_spent_microusd, result, error, updated_at`;

export function planBranch(planId: string): string {
  return `plan/${planId}`;
}

export interface ProposeInput {
  body: unknown;
  operator: string;
}

export interface ProposeResult {
  plan_id: string;
  project_id: string;
  state: PlanState;
  assumptions: string[];
  egress: string[];
}

/**
 * Baseline section 5 step 2. The orchestrator re-validates rather than trusting
 * the planning client, because the client is an agent and the schema is the
 * only thing standing between a bad plan and a dispatched one.
 */
export async function proposePlan(deps: Deps, input: ProposeInput): Promise<ProposeResult> {
  const validated = validatePlan(input.body);
  if (!validated.ok) {
    throw HttpError.badRequest('invalid_plan', 'plan failed validation', validated.issues);
  }
  const plan = validated.value;

  const created = await withTransaction(deps.pool, async (client) => {
    const project = await resolveProject(client, deps, plan);
    const now = deps.clock.now();
    const planId = deps.newId();

    await client.query(
      `INSERT INTO plans (id, project_id, state, env, spec, proposed_at, proposed_by, updated_at)
       VALUES ($1, $2, 'proposed', $3, $4, $5, $6, $5)`,
      [planId, project.id, plan.env, JSON.stringify(plan), now, input.operator],
    );

    // Plan-local task ids are what depends_on refers to; the database ids are
    // what everything after dispatch refers to.
    const idByLocal = new Map<string, string>();
    for (const task of plan.tasks) {
      const taskId = deps.newId();
      idByLocal.set(task.id, taskId);
      await client.query(
        `INSERT INTO tasks (id, plan_id, local_id, state, spec, updated_at)
         VALUES ($1, $2, $3, 'pending', $4, $5)`,
        [taskId, planId, task.id, JSON.stringify(task), now],
      );
    }

    for (const task of plan.tasks) {
      for (const dependency of task.depends_on ?? []) {
        await client.query(
          `INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ($1, $2)`,
          [idByLocal.get(task.id), idByLocal.get(dependency)],
        );
      }
    }

    await recordPlanStateChange(client, deps, {
      planId,
      projectId: project.id,
      from: null,
      to: 'proposed',
      reason: 'proposed',
    });
    await recordOperatorAction(client, deps, {
      action: 'propose_plan',
      operator: input.operator,
      projectId: project.id,
      planId,
    });

    return { planId, project };
  });

  // Repo creation is deliberately outside the transaction: Gitea is a separate
  // system and a network failure there must not lose the plan. Approve retries.
  if (created.project.gitea_repo === null) {
    await ensureRepoAfterCommit(deps, created.project, created.planId);
  }

  return {
    plan_id: created.planId,
    project_id: created.project.id,
    state: 'proposed',
    assumptions: plan.assumptions,
    egress: plan.egress ?? [],
  };
}

interface ProjectRecord {
  id: string;
  name: string;
  gitea_repo: string | null;
}

async function resolveProject(
  client: PoolClient,
  deps: Deps,
  plan: Plan,
): Promise<ProjectRecord> {
  const ref = plan.project as { id?: string; name?: string };

  if (ref.id !== undefined) {
    const { rows } = await client.query<ProjectRecord>(
      'SELECT id, name, gitea_repo FROM projects WHERE id = $1',
      [ref.id],
    );
    const existing = rows[0];
    if (!existing) throw HttpError.notFound('project');
    return existing;
  }

  const name = ref.name as string;
  const { rows } = await client.query<ProjectRecord>(
    'SELECT id, name, gitea_repo FROM projects WHERE name = $1',
    [name],
  );
  const existing = rows[0];
  if (existing) return existing;

  const id = deps.newId();
  await client.query(
    'INSERT INTO projects (id, name, gitea_repo, created_at) VALUES ($1, $2, NULL, $3)',
    [id, name, deps.clock.now()],
  );
  return { id, name, gitea_repo: null };
}

async function ensureRepoAfterCommit(
  deps: Deps,
  project: ProjectRecord,
  planId: string,
): Promise<void> {
  try {
    await deps.gitea.ensureRepo(project.name);
    await deps.pool.query('UPDATE projects SET gitea_repo = $1 WHERE id = $2', [
      project.name,
      project.id,
    ]);
  } catch (error) {
    await withTransaction(deps.pool, (client) =>
      recordEvent(client, deps, {
        type: 'error',
        severity: 'error',
        projectId: project.id,
        planId,
        payload: { stage: 'ensure_repo', message: (error as Error).message },
      }),
    );
  }
}

export async function recordOperatorAction(
  client: PoolClient,
  deps: Deps,
  args: {
    action: string;
    operator: string;
    projectId?: string | null;
    planId?: string | null;
    taskId?: string | null;
  },
): Promise<void> {
  await recordEvent(client, deps, {
    type: 'operator.action',
    projectId: args.projectId ?? null,
    planId: args.planId ?? null,
    taskId: args.taskId ?? null,
    payload: { action: args.action, operator: args.operator },
  });
}

export async function getPlanRow(deps: Deps, planId: string): Promise<PlanRow> {
  const { rows } = await deps.pool.query<PlanRow>(
    `SELECT ${PLAN_COLUMNS} FROM plans WHERE id = $1`,
    [planId],
  );
  const plan = rows[0];
  if (!plan) throw HttpError.notFound('plan');
  return plan;
}

export interface ApproveResult {
  plan_id: string;
  state: PlanState;
  approved_at: Date;
  approved_by: string;
  already_approved: boolean;
}

/**
 * Baseline section 5 step 3 and goal G2. Approval is a database fact: nothing
 * dispatches without `approved_at`, and the dispatcher checks that column
 * rather than the state alone.
 */
export async function approvePlan(
  deps: Deps,
  input: { planId: string; operator: string },
): Promise<ApproveResult> {
  const plan = await getPlanRow(deps, input.planId);

  if (plan.approved_at !== null) {
    // Idempotent: a second approval does no Gitea work and changes nothing.
    return {
      plan_id: plan.id,
      state: plan.state,
      approved_at: plan.approved_at,
      approved_by: plan.approved_by ?? input.operator,
      already_approved: true,
    };
  }
  if (plan.state !== 'proposed') {
    throw HttpError.conflict('illegal_transition', `cannot approve a ${plan.state} plan`);
  }

  const { rows } = await deps.pool.query<ProjectRecord>(
    'SELECT id, name, gitea_repo FROM projects WHERE id = $1',
    [plan.project_id],
  );
  const project = rows[0];
  if (!project) throw HttpError.notFound('project');

  const branch = planBranch(plan.id);
  let bot: { token: string; ref: string };

  // Approval cannot complete without the branch and the bot token: they are
  // what makes the plan executable. A Gitea outage is reported as such rather
  // than as an unexplained failure, and the plan stays proposed for a retry.
  try {
    // Retry of the repo creation that propose may have failed at.
    if (project.gitea_repo === null) {
      await deps.gitea.ensureRepo(project.name);
      await deps.pool.query('UPDATE projects SET gitea_repo = $1 WHERE id = $2', [
        project.name,
        project.id,
      ]);
    }

    await deps.gitea.createBranch(project.name, branch, 'main');
    bot = await deps.gitea.createBotToken(project.name, plan.id);
  } catch (error) {
    throw new HttpError(
      502,
      'gitea_unavailable',
      `could not prepare the plan branch: ${(error as Error).message}`,
    );
  }

  const orchestratorToken = mintToken();
  const now = deps.clock.now();

  const updated = await withTransaction(deps.pool, async (client) => {
    // Compare-and-set on the state, so a concurrent approve cannot double-mint.
    const { rowCount } = await client.query(
      `UPDATE plans
          SET state = 'queued', approved_at = $2, approved_by = $3, gitea_branch = $4,
              gitea_bot_token_ref = $5, agent_token_hash = $6, updated_at = $2
        WHERE id = $1 AND state = 'proposed' AND approved_at IS NULL`,
      [plan.id, now, input.operator, branch, bot.ref, hashToken(orchestratorToken)],
    );
    if (rowCount === 0) return false;

    await recordPlanStateChange(client, deps, {
      planId: plan.id,
      projectId: plan.project_id,
      from: 'proposed',
      to: 'queued',
      reason: 'approved',
    });
    await recordOperatorAction(client, deps, {
      action: 'approve_plan',
      operator: input.operator,
      projectId: plan.project_id,
      planId: plan.id,
    });
    await notifyWake(client);
    return true;
  });

  if (!updated) {
    // Lost the race. Undo the bot user so approval leaks nothing.
    await deps.gitea.revokeBotToken(bot.ref).catch(() => undefined);
    throw HttpError.conflict('illegal_transition', 'plan was no longer proposed');
  }

  // Plaintext lives only here, until the dispatcher hands it to the supervisor.
  deps.tokens.set(plan.id, { orchestratorToken, giteaBotToken: bot.token });

  return {
    plan_id: plan.id,
    state: 'queued',
    approved_at: now,
    approved_by: input.operator,
    already_approved: false,
  };
}

export async function rejectPlan(
  deps: Deps,
  input: { planId: string; operator: string },
): Promise<{ plan_id: string; state: PlanState }> {
  const plan = await getPlanRow(deps, input.planId);
  if (plan.state !== 'proposed') {
    throw HttpError.conflict('illegal_transition', `cannot reject a ${plan.state} plan`);
  }

  await withTransaction(deps.pool, async (client) => {
    await client.query('SELECT id FROM plans WHERE id = $1 FOR UPDATE', [plan.id]);
    await client.query(
      `UPDATE plans SET state = 'rejected', terminal_reason = 'rejected', updated_at = $2
        WHERE id = $1`,
      [plan.id, deps.clock.now()],
    );
    await client.query(
      `UPDATE tasks SET state = 'cancelled', updated_at = $2
        WHERE plan_id = $1 AND state NOT IN ('done', 'failed', 'cancelled')`,
      [plan.id, deps.clock.now()],
    );
    await recordPlanStateChange(client, deps, {
      planId: plan.id,
      projectId: plan.project_id,
      from: 'proposed',
      to: 'rejected',
      reason: 'rejected',
    });
    await recordOperatorAction(client, deps, {
      action: 'reject_plan',
      operator: input.operator,
      projectId: plan.project_id,
      planId: plan.id,
    });
  });

  return { plan_id: plan.id, state: 'rejected' };
}

export async function cancelPlan(
  deps: Deps,
  input: { planId: string; operator: string },
): Promise<{ plan_id: string; state: PlanState }> {
  const plan = await getPlanRow(deps, input.planId);
  if (isPlanTerminal(plan.state)) {
    throw HttpError.conflict('illegal_transition', `cannot cancel a ${plan.state} plan`);
  }

  const now = deps.clock.now();

  await withTransaction(deps.pool, async (client) => {
    // Plan row first, then its tasks: the same order every other writer uses.
    await client.query('SELECT id FROM plans WHERE id = $1 FOR UPDATE', [plan.id]);

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
        reason: 'plan_cancelled',
      });
    }

    await client.query(
      `UPDATE plans
          SET state = 'cancelled', terminal_reason = 'cancelled',
              agent_token_hash = NULL, updated_at = $2
        WHERE id = $1`,
      [plan.id, now],
    );
    await recordPlanStateChange(client, deps, {
      planId: plan.id,
      projectId: plan.project_id,
      from: plan.state,
      to: 'cancelled',
      reason: 'cancelled',
    });
    await recordOperatorAction(client, deps, {
      action: 'cancel_plan',
      operator: input.operator,
      projectId: plan.project_id,
      planId: plan.id,
    });
  });

  await releasePlanResources(deps, plan, 'cancelled');

  return { plan_id: plan.id, state: 'cancelled' };
}

/**
 * Teardown authorisation plus secret destruction. Idempotent and safe to call
 * twice: the supervisor keys teardown on the plan's terminal state (B15).
 */
export async function releasePlanResources(
  deps: Deps,
  plan: PlanRow,
  reason: 'completion' | 'ttl_expired' | 'cancelled' | 'failed',
): Promise<void> {
  deps.tokens.delete(plan.id);

  if (plan.gitea_bot_token_ref !== null) {
    try {
      await deps.gitea.revokeBotToken(plan.gitea_bot_token_ref);
    } catch (error) {
      await withTransaction(deps.pool, (client) =>
        recordEvent(client, deps, {
          type: 'error',
          severity: 'error',
          planId: plan.id,
          payload: { stage: 'revoke_bot_token', message: (error as Error).message },
        }),
      );
    }
  }

  if (plan.agent_id === null) return;

  const { rows } = await deps.pool.query<{ id: string; name: string; base_url: string }>(
    'SELECT id, name, base_url FROM agents WHERE id = $1',
    [plan.agent_id],
  );
  const agent = rows[0];
  if (!agent) return;

  try {
    await deps.supervisors.authorizeTeardown(agent, plan.id, reason);
  } catch (error) {
    await withTransaction(deps.pool, (client) =>
      recordEvent(client, deps, {
        type: 'error',
        severity: 'error',
        planId: plan.id,
        payload: { stage: 'authorize_teardown', message: (error as Error).message },
      }),
    );
  }
}

/**
 * There is no pagination anywhere in v1, so this is a cap rather than a page
 * size. Exported because a page that hits it has to say so: silently showing
 * 200 of 340 plans is the kind of lie an operator only catches by counting.
 */
export const PLAN_LIST_LIMIT = 200;

export async function listPlans(
  deps: Deps,
  filter: { state?: string; projectId?: string },
): Promise<PlanRow[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter.state !== undefined) {
    params.push(filter.state);
    conditions.push(`state = $${params.length}`);
  }
  if (filter.projectId !== undefined) {
    params.push(filter.projectId);
    conditions.push(`project_id = $${params.length}`);
  }

  const where = conditions.length === 0 ? '' : ` WHERE ${conditions.join(' AND ')}`;
  const { rows } = await deps.pool.query<PlanRow>(
    `SELECT ${PLAN_COLUMNS} FROM plans${where}
      ORDER BY proposed_at DESC LIMIT ${PLAN_LIST_LIMIT}`,
    params,
  );
  return rows;
}

export interface TaskRollup {
  /** Task counts by state, for the plan tables. */
  states: Record<string, number>;
  costMicrousd: number;
}

/**
 * Per-plan task states and spend, in one query rather than one per plan.
 *
 * Lives here rather than beside the page that first needed it because three
 * pages now render the same numbers, and the sum over `tasks` is the only
 * definition of a plan's spend — no plan row carries one.
 */
export async function taskRollup(
  deps: Deps,
  planIds: string[],
): Promise<Map<string, TaskRollup>> {
  const result = new Map<string, TaskRollup>();
  if (planIds.length === 0) return result;

  // `::bigint`, not `::int`: microusd overflows int4 at $2,147.48. `pg`
  // returns a bigint aggregate as a string, so it is parsed explicitly below
  // rather than trusted to coerce.
  const { rows } = await deps.pool.query<{
    plan_id: string;
    state: string;
    n: number;
    cost_microusd: string;
  }>(
    `SELECT plan_id, state::text AS state, count(*)::int AS n,
            coalesce(sum(cost_spent_microusd), 0)::bigint AS cost_microusd
       FROM tasks
      WHERE plan_id = ANY($1)
      GROUP BY plan_id, state`,
    [planIds],
  );

  for (const row of rows) {
    const entry = result.get(row.plan_id) ?? { states: {}, costMicrousd: 0 };
    entry.states[row.state] = row.n;
    entry.costMicrousd += Number(row.cost_microusd);
    result.set(row.plan_id, entry);
  }

  return result;
}

export async function listTasks(deps: Deps, planId: string): Promise<TaskRow[]> {
  // `cost_spent_microusd` is bigint; `pg` returns it as a string even for a
  // single, unaggregated row, so it is parsed explicitly on the way out.
  const { rows } = await deps.pool.query<Omit<TaskRow, 'cost_spent_microusd'> & {
    cost_spent_microusd: string;
  }>(`SELECT ${TASK_COLUMNS} FROM tasks WHERE plan_id = $1 ORDER BY local_id`, [planId]);
  return rows.map((row) => ({ ...row, cost_spent_microusd: Number(row.cost_spent_microusd) }));
}
