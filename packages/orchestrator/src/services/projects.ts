import type { Deps } from '../deps.js';
import { HttpError } from '../errors.js';

/**
 * Projects, as far as the database knows them: `id`, `name`, `gitea_repo`,
 * `created_at`. There is no lifecycle column, no owner, no budget and no
 * archive flag, so this service invents none of those.
 *
 * Everything a project page shows beyond those four fields is derived from its
 * plans. That is the honest shape of the data, and it is why the summary below
 * is two queries joined in TypeScript rather than one query pretending a
 * project has state of its own.
 */

export interface ProjectRow {
  id: string;
  name: string;
  /** Null until the repo is created — propose tries, and approve retries. */
  gitea_repo: string | null;
  created_at: Date;
}

export interface ProjectSummary extends ProjectRow {
  /** Plan counts by state. Empty for a project whose plans were all deleted. */
  states: Record<string, number>;
  plans: number;
  proposed: number;
  tokens: number;
  /**
   * `max(plans.updated_at)`. Deliberately not called "last activity": it is a
   * row timestamp, not an event, and a project can be busy without it moving.
   */
  lastPlanUpdate: Date | null;
}

export async function getProjectRow(deps: Deps, projectId: string): Promise<ProjectRow> {
  const { rows } = await deps.pool.query<ProjectRow>(
    'SELECT id, name, gitea_repo, created_at FROM projects WHERE id = $1',
    [projectId],
  );
  const project = rows[0];
  if (!project) throw HttpError.notFound('project');
  return project;
}

export async function listProjects(deps: Deps): Promise<ProjectSummary[]> {
  const [{ rows: projects }, { rows: rollup }] = await Promise.all([
    deps.pool.query<ProjectRow>(
      'SELECT id, name, gitea_repo, created_at FROM projects ORDER BY name',
    ),
    // The spend subquery groups tasks once rather than joining them row-by-row
    // into the plan count, which would multiply every plan by its task count.
    deps.pool.query<{
      project_id: string;
      state: string;
      n: number;
      tokens: number;
      last_update: Date;
    }>(
      `SELECT p.project_id, p.state::text AS state, count(*)::int AS n,
              coalesce(sum(t.tokens), 0)::int AS tokens,
              max(p.updated_at) AS last_update
         FROM plans p
         LEFT JOIN (
           SELECT plan_id, sum(tokens_spent)::int AS tokens FROM tasks GROUP BY plan_id
         ) t ON t.plan_id = p.id
        GROUP BY p.project_id, p.state`,
    ),
  ]);

  const byProject = new Map<string, ProjectSummary>();
  for (const project of projects) {
    byProject.set(project.id, {
      ...project,
      states: {},
      plans: 0,
      proposed: 0,
      tokens: 0,
      lastPlanUpdate: null,
    });
  }

  for (const row of rollup) {
    const summary = byProject.get(row.project_id);
    // A plan cannot exist without its project row, but a rollup that outlived
    // one would silently vanish rather than throw on a page the operator is
    // reading to find out what is wrong.
    if (summary === undefined) continue;

    summary.states[row.state] = row.n;
    summary.plans += row.n;
    summary.tokens += row.tokens;
    if (row.state === 'proposed') summary.proposed = row.n;
    if (
      row.last_update !== null &&
      (summary.lastPlanUpdate === null || row.last_update > summary.lastPlanUpdate)
    ) {
      summary.lastPlanUpdate = row.last_update;
    }
  }

  return [...byProject.values()];
}
