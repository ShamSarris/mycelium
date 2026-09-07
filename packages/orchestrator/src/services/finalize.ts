import { withTransaction } from '../db/pool.js';
import type { Deps } from '../deps.js';
import { allPassed, evaluateCriteria, type SuccessCriterion } from '../domain/criteria.js';
import type { TaskState } from '../domain/states.js';
import { recordEvent } from './events.js';
import { recordPlanStateChange } from './state.js';
import { PLAN_COLUMNS, releasePlanResources, type PlanRow } from './plans.js';

export interface PlanManifest {
  head_sha: string | null;
  pr_url: string | null;
  criteria: Array<{ type: string; path?: string; passed: boolean }>;
  /** Authoritative spend (D30, future_work/database.md:59). Primary figure. */
  cost_spent_microusd: number;
  /** Detail figure, kept beside the authoritative cost. */
  tokens_spent: number;
  wall_clock_ms: number;
  terminal_reason: string | null;
}

/**
 * Baseline section 5 step 7. Evaluate the declared criteria, open the pull
 * request, write the manifest, and only then authorise teardown: pushed commits
 * are the only thing that survives, so the record of them is written first.
 *
 * Safe to call repeatedly. A Gitea failure leaves the plan in `finalizing` and
 * the next tick retries.
 */
export async function runFinalize(deps: Deps, planId: string): Promise<void> {
  const { rows } = await deps.pool.query<PlanRow & { project_name: string; gitea_repo: string | null }>(
    `SELECT ${PLAN_COLUMNS.split(',').map((c) => `p.${c.trim()}`).join(', ')},
            pr.name AS project_name, pr.gitea_repo
       FROM plans p JOIN projects pr ON pr.id = p.project_id
      WHERE p.id = $1`,
    [planId],
  );
  const plan = rows[0];
  if (!plan || plan.state !== 'finalizing') return;

  // cost_spent_microusd is bigint; `pg` would hand it back as a string, but
  // src/db/pool.ts installs a global INT8 type parser that coerces it to a JS
  // number for every query in this process (safe well past 2^31 — see
  // src/services/dispatcher.ts's budgetExhausted).
  const { rows: taskRows } = await deps.pool.query<{
    state: TaskState;
    tokens_spent: number;
    cost_spent_microusd: number;
  }>(
    'SELECT state, tokens_spent, cost_spent_microusd FROM tasks WHERE plan_id = $1',
    [planId],
  );

  const repo = plan.gitea_repo;
  const branch = plan.gitea_branch;

  let outcomes;
  let headSha: string | null = null;
  let prUrl: string | null = null;

  try {
    outcomes = await evaluateCriteria({
      criteria: plan.spec.success_criteria as SuccessCriterion[],
      taskStates: taskRows.map((t) => t.state),
      repo,
      branch,
      gitea: deps.gitea,
    });

    if (repo !== null && branch !== null) {
      const pr = await deps.gitea.openPullRequest(repo, branch, 'main', `Plan ${plan.id}`);
      prUrl = pr?.url ?? null;
      headSha = await deps.gitea.headSha(repo, branch);
    }
  } catch (error) {
    // Hold the plan in finalizing and retry on the next tick rather than
    // writing a manifest that claims less than actually happened.
    await withTransaction(deps.pool, (client) =>
      recordEvent(client, deps, {
        type: 'error',
        severity: 'error',
        projectId: plan.project_id,
        planId: plan.id,
        payload: { stage: 'finalize', message: (error as Error).message },
      }),
    );
    return;
  }

  const now = deps.clock.now();
  const manifest: PlanManifest = {
    head_sha: headSha,
    pr_url: prUrl,
    criteria: outcomes,
    cost_spent_microusd: taskRows.reduce((sum, t) => sum + t.cost_spent_microusd, 0),
    tokens_spent: taskRows.reduce((sum, t) => sum + t.tokens_spent, 0),
    wall_clock_ms: plan.running_at === null ? 0 : now.getTime() - plan.running_at.getTime(),
    terminal_reason: plan.terminal_reason,
  };

  const passed = allPassed(outcomes) && plan.terminal_reason === null;
  const finalState = passed ? 'done' : 'failed';

  const committed = await withTransaction(deps.pool, async (client) => {
    const { rowCount } = await client.query(
      `UPDATE plans
          SET state = $2, manifest = $3, agent_token_hash = NULL, updated_at = $4,
              terminal_reason = COALESCE(terminal_reason, $5)
        WHERE id = $1 AND state = 'finalizing'`,
      [plan.id, finalState, JSON.stringify(manifest), now, passed ? null : 'criteria_failed'],
    );
    if (rowCount === 0) return false;

    await recordPlanStateChange(client, deps, {
      planId: plan.id,
      projectId: plan.project_id,
      from: 'finalizing',
      to: finalState,
      reason: plan.terminal_reason ?? (passed ? 'criteria_passed' : 'criteria_failed'),
    });
    return true;
  });

  if (!committed) return;

  await releasePlanResources(deps, plan, teardownReason(plan, passed));
}

function teardownReason(
  plan: PlanRow,
  passed: boolean,
): 'completion' | 'ttl_expired' | 'cancelled' | 'failed' {
  if (plan.terminal_reason === 'ttl_expired') return 'ttl_expired';
  if (plan.terminal_reason === 'supervisor_lost') return 'failed';
  return passed ? 'completion' : 'failed';
}
