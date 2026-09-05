import type { GiteaClient } from '../clients/gitea.js';
import type { TaskState } from './states.js';

/**
 * Success criteria are declarative and evaluated by the orchestrator at
 * finalize (baseline section 5 step 7). v1 supports two.
 */
export type SuccessCriterion =
  | { type: 'all_tasks_done' }
  | { type: 'file_exists_in_branch'; path: string };

export interface CriterionOutcome {
  type: string;
  path?: string;
  passed: boolean;
}

export interface CriteriaContext {
  criteria: readonly SuccessCriterion[];
  taskStates: readonly TaskState[];
  repo: string | null;
  branch: string | null;
  gitea: Pick<GiteaClient, 'fileExists'>;
}

/**
 * Evaluated against durable state only. `file_exists_in_branch` reads whatever
 * Gitea holds when finalize runs: there is no wait for a final push, so a plan
 * that never pushed fails the criterion rather than blocking.
 */
export async function evaluateCriteria(ctx: CriteriaContext): Promise<CriterionOutcome[]> {
  const outcomes: CriterionOutcome[] = [];

  for (const criterion of ctx.criteria) {
    if (criterion.type === 'all_tasks_done') {
      outcomes.push({
        type: criterion.type,
        passed: ctx.taskStates.length > 0 && ctx.taskStates.every((s) => s === 'done'),
      });
      continue;
    }

    if (criterion.type === 'file_exists_in_branch') {
      let passed = false;
      if (ctx.repo !== null && ctx.branch !== null) {
        passed = await ctx.gitea.fileExists(ctx.repo, ctx.branch, criterion.path);
      }
      outcomes.push({ type: criterion.type, path: criterion.path, passed });
      continue;
    }

    outcomes.push({ type: (criterion as { type: string }).type, passed: false });
  }

  return outcomes;
}

export function allPassed(outcomes: readonly CriterionOutcome[]): boolean {
  return outcomes.every((o) => o.passed);
}
