import type { PoolClient } from 'pg';
import type { Plan } from '@mycelium/contracts';
import { withTransaction } from '../db/pool.js';
import type { Deps } from '../deps.js';
import { nextAttemptDelay } from '../domain/backoff.js';
import { planCostCeiling, wouldCrossCeiling } from '../domain/budget.js';
import { selectSupervisors } from '../domain/selection.js';
import type { TaskState } from '../domain/states.js';
import type { AgentTarget, PlanDispatch, TaskDispatch } from '../clients/supervisor.js';
import { recordEvent } from './events.js';
import { recordPlanStateChange, recordTaskStateChange } from './state.js';
import { runFinalize } from './finalize.js';
import {
  PLAN_COLUMNS,
  TASK_COLUMNS,
  planBranch,
  type PlanRow,
  type TaskRow,
} from './plans.js';
import { AGENT_COLUMNS, type AgentRow } from './supervisorsRegistry.js';
import { enforceWallClock, expireLeases, haltPlan, promoteReadyTasks } from './tasks.js';
import { hashToken, mintToken, type PlanSecrets } from '../tokens.js';

/**
 * One pass of the control loop. Written as a plain function so tests drive it
 * directly with a controlled clock; `startDispatcher` only adds the timer and
 * the LISTEN hint.
 */
export async function tick(deps: Deps): Promise<void> {
  await provisionQueuedPlans(deps);
  await expireLeases(deps);
  await enforceWallClock(deps);
  // Promotion runs before dispatch so a task unblocked by this tick can also be
  // dispatched by it. The status handler promotes too; doing it here as well is
  // what makes a missed promotion self-heal.
  await promoteAcrossRunningPlans(deps);
  await dispatchReadyTasks(deps);
  await detectLostSupervisors(deps);
  await enforceTtl(deps);
  await finalizeTerminalPlans(deps);
}

// --------------------------------------------------------------------------
// 1. Provision

async function provisionQueuedPlans(deps: Deps): Promise<void> {
  const now = deps.clock.now();
  // Goal G2: approval is a database precondition. This checks approved_at
  // rather than trusting the state column alone.
  const { rows } = await deps.pool.query<PlanRow>(
    `SELECT ${PLAN_COLUMNS} FROM plans
      WHERE state = 'queued'
        AND approved_at IS NOT NULL
        AND (next_provision_at IS NULL OR next_provision_at <= $1)
      ORDER BY proposed_at`,
    [now],
  );

  for (const plan of rows) {
    await provisionPlan(deps, plan);
  }
}

async function provisionPlan(deps: Deps, plan: PlanRow): Promise<void> {
  const claimed = await withTransaction(deps.pool, async (client) => {
    const { rowCount } = await client.query(
      `UPDATE plans SET state = 'provisioning', updated_at = $2
        WHERE id = $1 AND state = 'queued' AND approved_at IS NOT NULL`,
      [plan.id, deps.clock.now()],
    );
    if (rowCount === 0) return false;
    await recordPlanStateChange(client, deps, {
      planId: plan.id,
      projectId: plan.project_id,
      from: 'queued',
      to: 'provisioning',
      reason: 'selecting_supervisor',
    });
    return true;
  });
  if (!claimed) return;

  const { rows: candidateRows } = await deps.pool.query<AgentRow>(
    `SELECT ${AGENT_COLUMNS} FROM agents`,
  );
  const candidates = selectSupervisors(candidateRows, {
    env: plan.env,
    now: deps.clock.now(),
    healthyWithinMs: deps.config.heartbeatHealthyMinutes * 60_000,
  });

  if (candidates.length === 0) {
    await returnToQueue(deps, plan, 'no_healthy_supervisor');
    return;
  }

  let secrets: PlanSecrets;
  let dispatch: PlanDispatch;
  try {
    secrets = await ensurePlanSecrets(deps, plan);
    dispatch = await buildPlanDispatch(deps, plan, secrets);
  } catch (error) {
    await withTransaction(deps.pool, (client) =>
      recordEvent(client, deps, {
        type: 'error',
        severity: 'error',
        planId: plan.id,
        payload: { stage: 'plan_dispatch_prepare', message: (error as Error).message },
      }),
    );
    await returnToQueue(deps, plan, 'dispatch_prepare_failed');
    return;
  }

  // First-fit (B12): try candidates in order until one accepts. The supervisor
  // owns capacity truth, so a rejection is information, not a failure.
  for (const candidate of candidates) {
    const result = await deps.supervisors.dispatchPlan(candidate, dispatch);

    if (result.accepted) {
      await markRunning(deps, plan, candidate.id);
      return;
    }

    if (result.code === 'validation_failed') {
      await failProvisioning(deps, plan, candidate, 'validation_failed');
      return;
    }
  }

  await returnToQueue(deps, plan, 'all_candidates_rejected');
}

/**
 * The per-plan secrets minted at approval live only in this process. After a
 * restart the cache is empty, so they are re-minted here and the hash rewritten
 * in the same transaction: a restart costs a new token, not a stuck plan.
 */
async function ensurePlanSecrets(deps: Deps, plan: PlanRow): Promise<PlanSecrets> {
  const cached = deps.tokens.get(plan.id);
  if (cached) return cached;

  const { rows } = await deps.pool.query<{ name: string; gitea_repo: string | null }>(
    'SELECT name, gitea_repo FROM projects WHERE id = $1',
    [plan.project_id],
  );
  const project = rows[0];
  if (!project) throw new Error('project row vanished');

  const repo = project.gitea_repo ?? (await deps.gitea.ensureRepo(project.name), project.name);
  const bot = await deps.gitea.createBotToken(repo, plan.id);
  const orchestratorToken = mintToken();

  const previousRef = plan.gitea_bot_token_ref;

  await deps.pool.query(
    `UPDATE plans SET agent_token_hash = $2, gitea_bot_token_ref = $3, updated_at = $4
      WHERE id = $1`,
    [plan.id, hashToken(orchestratorToken), bot.ref, deps.clock.now()],
  );

  if (previousRef !== null && previousRef !== bot.ref) {
    await deps.gitea.revokeBotToken(previousRef).catch(() => undefined);
  }

  const secrets: PlanSecrets = { orchestratorToken, giteaBotToken: bot.token };
  deps.tokens.set(plan.id, secrets);
  return secrets;
}

async function buildPlanDispatch(
  deps: Deps,
  plan: PlanRow,
  secrets: PlanSecrets,
): Promise<PlanDispatch> {
  const { rows } = await deps.pool.query<{ id: string; name: string; gitea_repo: string | null }>(
    'SELECT id, name, gitea_repo FROM projects WHERE id = $1',
    [plan.project_id],
  );
  const project = rows[0];
  if (!project) throw new Error('project row vanished');

  const repo = project.gitea_repo ?? project.name;
  const base = deps.config.gitea.baseUrl.replace(/\/$/, '');
  const spec = plan.spec as Plan;

  return {
    plan_id: plan.id,
    project: { id: project.id, name: project.name },
    gitea: {
      repo_url: `${base}/${deps.config.gitea.owner}/${repo}.git`,
      branch: plan.gitea_branch ?? planBranch(plan.id),
      bot_token: secrets.giteaBotToken,
    },
    orchestrator_token: secrets.orchestratorToken,
    egress: spec.egress ?? [],
    env_ttl_min: spec.env_ttl_min ?? 240,
  };
}

async function markRunning(deps: Deps, plan: PlanRow, agentId: string): Promise<void> {
  const now = deps.clock.now();
  const ttlMin = (plan.spec as Plan).env_ttl_min ?? 240;
  const ttl = new Date(now.getTime() + ttlMin * 60_000);

  await withTransaction(deps.pool, async (client) => {
    await client.query(
      `UPDATE plans
          SET state = 'running', agent_id = $2, running_at = $3, ttl_expires_at = $4,
              provision_attempts = 0, next_provision_at = NULL, updated_at = $3
        WHERE id = $1 AND state = 'provisioning'`,
      [plan.id, agentId, now, ttl],
    );
    await recordPlanStateChange(client, deps, {
      planId: plan.id,
      projectId: plan.project_id,
      from: 'provisioning',
      to: 'running',
      reason: 'supervisor_accepted',
    });
    // Placement is sticky for the life of the plan (B12): agent_id is never
    // reassigned, so a lost VM fails the plan rather than migrating it.
    await promoteReadyTasks(client, deps, plan.id);
  });
}

async function returnToQueue(deps: Deps, plan: PlanRow, reason: string): Promise<void> {
  const attempts = plan.provision_attempts + 1;
  const now = deps.clock.now();
  const retryAt = new Date(now.getTime() + nextAttemptDelay(attempts));

  await withTransaction(deps.pool, async (client) => {
    await client.query(
      `UPDATE plans
          SET state = 'queued', provision_attempts = $2, next_provision_at = $3, updated_at = $4
        WHERE id = $1 AND state = 'provisioning'`,
      [plan.id, attempts, retryAt, now],
    );
    await recordPlanStateChange(client, deps, {
      planId: plan.id,
      projectId: plan.project_id,
      from: 'provisioning',
      to: 'queued',
      reason,
    });
  });
}

async function failProvisioning(
  deps: Deps,
  plan: PlanRow,
  candidate: AgentTarget,
  reason: string,
): Promise<void> {
  const now = deps.clock.now();

  await withTransaction(deps.pool, async (client) => {
    await client.query('SELECT id FROM plans WHERE id = $1 FOR UPDATE', [plan.id]);
    await client.query(
      `UPDATE tasks SET state = 'cancelled', finished_at = $2, updated_at = $2
        WHERE plan_id = $1 AND state NOT IN ('done', 'failed', 'cancelled')`,
      [plan.id, now],
    );
    await client.query(
      `UPDATE plans SET state = 'finalizing', terminal_reason = $2, updated_at = $3
        WHERE id = $1 AND state = 'provisioning'`,
      [plan.id, reason, now],
    );
    await recordEvent(client, deps, {
      type: 'error',
      severity: 'error',
      planId: plan.id,
      payload: { stage: 'plan_dispatch', supervisor: candidate.name, reason },
    });
    await recordPlanStateChange(client, deps, {
      planId: plan.id,
      projectId: plan.project_id,
      from: 'provisioning',
      to: 'finalizing',
      reason,
    });
  });

  await runFinalize(deps, plan.id);
}

// --------------------------------------------------------------------------
// 2. Promote and dispatch

async function promoteAcrossRunningPlans(deps: Deps): Promise<void> {
  const { rows } = await deps.pool.query<{ id: string }>(
    "SELECT id FROM plans WHERE state = 'running'",
  );
  for (const plan of rows) {
    await withTransaction(deps.pool, (client) => promoteReadyTasks(client, deps, plan.id));
  }
}

async function dispatchReadyTasks(deps: Deps): Promise<void> {
  const { rows } = await deps.pool.query<PlanRow>(
    `SELECT ${PLAN_COLUMNS} FROM plans WHERE state = 'running' AND agent_id IS NOT NULL`,
  );

  for (const plan of rows) {
    const { rows: agentRows } = await deps.pool.query<AgentRow>(
      `SELECT ${AGENT_COLUMNS} FROM agents WHERE id = $1`,
      [plan.agent_id],
    );
    const agent = agentRows[0];
    if (!agent) continue;

    // How many tasks may be in flight on one plan's VM at once. Unresolved:
    // this is a different quantity from the subagent concurrency ticket 13
    // settled (that one is derived by the supervisor from the VM's memory and
    // never appears on the wire), and it outlived the stopgap it was written
    // beside. The agent itself takes one task at a time and refuses a second
    // with a 409 (`packages/worker/src/dispatch.ts`), so the effective
    // parallelism is 1 and the extra claim costs a refuse-and-requeue round
    // trip each tick. Left as-is rather than quietly changed to 1: it is a
    // behaviour change, not a cleanup.
    const max = 2;

    // Claim one at a time so a supervisor that starts rejecting stops the loop
    // rather than draining the whole queue into a dead VM.
    for (;;) {
      const claimed = await claimNextTask(deps, plan, max);
      if (!claimed) break;

      const dispatched = await sendTask(deps, plan, agent, claimed);
      if (!dispatched) break;
    }
  }
}

/** Renders microusd as dollars for operator-facing prose (halt reasons, manifests). */
function formatMicrousd(microusd: number): string {
  return `$${(microusd / 1_000_000).toFixed(2)}`;
}

/**
 * The plan-level cost ceiling (ticket 0005 part B; cost-denominated by D30).
 *
 * Called inside the claim transaction, after the plan row is locked, so the
 * check and the claim cannot be split by a concurrent tick. It looks at the
 * task that would go next and refuses if that task's *ceiling* would carry the
 * plan past its own — not an estimate of what the task will use, because a
 * gate that let a task start on the hope it comes in under budget is a ceiling
 * that only holds for well-behaved plans.
 *
 * Halting rather than stalling: `haltPlan` cancels the siblings and moves the
 * plan to `finalizing`, so the operator gets a manifest saying the plan ran out
 * of budget instead of a plan that sits in `running` forever.
 */
async function budgetExhausted(
  client: PoolClient,
  deps: Deps,
  plan: PlanRow,
): Promise<boolean> {
  const { rows: next } = await client.query<{
    id: string;
    spec: { limits: { cost_microusd: number } };
  }>(
    `SELECT id, spec FROM tasks
      WHERE plan_id = $1 AND state = 'ready'
      ORDER BY local_id
      LIMIT 1`,
    [plan.id],
  );
  const candidate = next[0];
  if (candidate === undefined) return false;

  // Every other task on the plan, whatever state it ended in — a failed
  // attempt spent its cost too, and not counting those would let a plan of
  // failures run until the provider cut it off.
  //
  // The candidate's own spend is excluded because `limits.cost_microusd` is
  // task-wide across attempts: a retry's worst case is still that one
  // ceiling, and counting both would charge the same allowance twice and make
  // retries impossible.
  //
  // `::bigint`, not `::int`: microusd overflows int4 at $2,147.48. `pg` hands
  // bigint back as a string by default, but src/db/pool.ts installs a global
  // INT8 type parser that coerces it to a JS number for every query in this
  // process — safe well past 2^31, since realistic plan budgets stay far
  // under Number.MAX_SAFE_INTEGER. The `?? 0` fallback still guards the case
  // where no rows are returned at all.
  const { rows: spend } = await client.query<{ total: number }>(
    `SELECT coalesce(sum(cost_spent_microusd), 0)::bigint AS total
       FROM tasks WHERE plan_id = $1 AND id <> $2`,
    [plan.id, candidate.id],
  );
  const spentOnOtherTasks = spend[0]?.total ?? 0;
  const planCeiling = planCostCeiling(plan.spec as Plan);

  if (
    !wouldCrossCeiling({
      spentOnOtherTasks,
      taskCeiling: candidate.spec.limits.cost_microusd,
      planCeiling,
    })
  ) {
    return false;
  }

  await recordEvent(client, deps, {
    type: 'limit.exceeded',
    severity: 'warn',
    planId: plan.id,
    taskId: candidate.id,
    payload: {
      limit: 'plan_cost',
      allowed: planCeiling,
      spent_on_other_tasks: spentOnOtherTasks,
      next_task_ceiling: candidate.spec.limits.cost_microusd,
    },
  });

  await haltPlan(
    client,
    deps,
    plan,
    `plan_budget_exceeded: ${formatMicrousd(spentOnOtherTasks)} spent on other tasks against a ceiling of ${formatMicrousd(planCeiling)}, and the next task may use ${formatMicrousd(candidate.spec.limits.cost_microusd)}`,
  );

  return true;
}

async function claimNextTask(deps: Deps, plan: PlanRow, max: number): Promise<TaskRow | null> {
  return withTransaction(deps.pool, async (client) => {
    // Serialise claiming per plan so two ticks cannot both read the same
    // in-flight count and overshoot `max`.
    await client.query('SELECT id FROM plans WHERE id = $1 FOR UPDATE', [plan.id]);

    const { rows: counts } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM tasks
        WHERE plan_id = $1 AND state IN ('dispatched', 'running')`,
      [plan.id],
    );
    if ((counts[0]?.n ?? 0) >= max) return null;

    if (await budgetExhausted(client, deps, plan)) return null;

    const now = deps.clock.now();
    const dispatchId = deps.newId();
    const lease = new Date(now.getTime() + deps.config.leaseSeconds * 1000);

    const { rows } = await client.query<TaskRow>(
      `UPDATE tasks
          SET state = 'dispatched', dispatch_id = $2, dispatch_attempt = dispatch_attempt + 1,
              lease_expires_at = $3, updated_at = $4
        WHERE id = (
          SELECT id FROM tasks
            WHERE plan_id = $1 AND state = 'ready'
            ORDER BY local_id
            FOR UPDATE SKIP LOCKED
            LIMIT 1
        )
        RETURNING ${TASK_COLUMNS}`,
      [plan.id, dispatchId, lease, now],
    );

    const task = rows[0];
    if (!task) return null;

    await recordTaskStateChange(client, deps, {
      planId: plan.id,
      taskId: task.id,
      from: 'ready',
      to: 'dispatched',
      reason: 'claimed',
    });
    await recordEvent(client, deps, {
      type: 'task.dispatched',
      planId: plan.id,
      taskId: task.id,
      payload: { dispatch_id: dispatchId, attempt: task.dispatch_attempt },
    });

    return task;
  });
}

async function sendTask(
  deps: Deps,
  plan: PlanRow,
  agent: AgentRow,
  task: TaskRow,
): Promise<boolean> {
  const request: TaskDispatch = {
    plan_id: plan.id,
    task_id: task.id,
    local_id: task.local_id,
    dispatch_id: task.dispatch_id as string,
    execution_attempt: task.execution_attempt,
    description: task.spec.description,
    limits: task.spec.limits,
    tokens_spent_so_far: task.tokens_spent,
  };

  try {
    const { accepted } = await deps.supervisors.dispatchTask(agent, request);
    if (accepted) return true;
    await returnTaskToReady(deps, plan, task, 'supervisor_rejected');
    return false;
  } catch (error) {
    // Do not wait out the lease: the failure is already known.
    await returnTaskToReady(deps, plan, task, (error as Error).message);
    return false;
  }
}

async function returnTaskToReady(
  deps: Deps,
  plan: PlanRow,
  task: TaskRow,
  reason: string,
): Promise<void> {
  await withTransaction(deps.pool, async (client) => {
    const { rowCount } = await client.query(
      `UPDATE tasks
          SET state = 'ready', lease_expires_at = NULL, dispatch_id = NULL, updated_at = $2
        WHERE id = $1 AND state = 'dispatched'`,
      [task.id, deps.clock.now()],
    );
    if (rowCount === 0) return;

    await recordTaskStateChange(client, deps, {
      planId: plan.id,
      taskId: task.id,
      from: 'dispatched',
      to: 'ready',
      reason: `dispatch_failed:${reason}`,
    });
  });
}

// --------------------------------------------------------------------------
// 3. TTL, lost supervisors, finalization

async function enforceTtl(deps: Deps): Promise<void> {
  const now = deps.clock.now();
  const { rows } = await deps.pool.query<PlanRow>(
    `SELECT ${PLAN_COLUMNS} FROM plans
      WHERE state = 'running' AND ttl_expires_at IS NOT NULL AND ttl_expires_at < $1`,
    [now],
  );

  for (const plan of rows) {
    await abortRunningPlan(deps, plan, 'ttl_expired');
  }
}

/**
 * A VM that stops heartbeating holds its plan until the TTL, which can be four
 * hours. This fails it sooner. NOTE: baseline section 10 says running plans on
 * an unhealthy VM "continue to TTL", so this is a deliberate divergence flagged
 * to the operator; setting SUPERVISOR_LOST_MIN very high disables it.
 */
async function detectLostSupervisors(deps: Deps): Promise<void> {
  const cutoff = new Date(deps.clock.now().getTime() - deps.config.supervisorLostMinutes * 60_000);

  const { rows } = await deps.pool.query<PlanRow>(
    `SELECT ${PLAN_COLUMNS.split(',').map((c) => `p.${c.trim()}`).join(', ')}
       FROM plans p JOIN agents a ON a.id = p.agent_id
      WHERE p.state = 'running'
        AND (a.last_heartbeat_at IS NULL OR a.last_heartbeat_at < $1)`,
    [cutoff],
  );

  for (const plan of rows) {
    await abortRunningPlan(deps, plan, 'supervisor_lost');
  }
}

async function abortRunningPlan(deps: Deps, plan: PlanRow, reason: string): Promise<void> {
  const now = deps.clock.now();

  await withTransaction(deps.pool, async (client) => {
    await client.query('SELECT id FROM plans WHERE id = $1 FOR UPDATE', [plan.id]);

    const { rows: openTasks } = await client.query<{ id: string; state: TaskState }>(
      `SELECT id, state FROM tasks
        WHERE plan_id = $1 AND state NOT IN ('done', 'failed', 'cancelled') FOR UPDATE`,
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
        reason,
      });
    }

    const { rowCount } = await client.query(
      `UPDATE plans SET state = 'finalizing', terminal_reason = $2, updated_at = $3
        WHERE id = $1 AND state = 'running'`,
      [plan.id, reason, now],
    );
    if (rowCount === 0) return;

    await recordPlanStateChange(client, deps, {
      planId: plan.id,
      projectId: plan.project_id,
      from: 'running',
      to: 'finalizing',
      reason,
    });
  });
}

async function finalizeTerminalPlans(deps: Deps): Promise<void> {
  // Running plans whose work is all terminal move to finalizing first.
  const { rows: complete } = await deps.pool.query<PlanRow>(
    `SELECT ${PLAN_COLUMNS} FROM plans p
      WHERE p.state = 'running'
        AND NOT EXISTS (
          SELECT 1 FROM tasks t
           WHERE t.plan_id = p.id AND t.state NOT IN ('done', 'failed', 'cancelled')
        )`,
  );

  for (const plan of complete) {
    await withTransaction(deps.pool, async (client) => {
      const { rowCount } = await client.query(
        `UPDATE plans SET state = 'finalizing', updated_at = $2 WHERE id = $1 AND state = 'running'`,
        [plan.id, deps.clock.now()],
      );
      if (rowCount === 0) return;
      await recordPlanStateChange(client, deps, {
        planId: plan.id,
        projectId: plan.project_id,
        from: 'running',
        to: 'finalizing',
        reason: 'all_tasks_terminal',
      });
    });
  }

  const { rows: finalizing } = await deps.pool.query<{ id: string }>(
    "SELECT id FROM plans WHERE state = 'finalizing'",
  );
  for (const plan of finalizing) {
    await runFinalize(deps, plan.id);
  }
}
