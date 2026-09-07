import type { ProjectRow, ProjectSummary } from '../services/projects.js';
import { ago } from './components.js';
import { formatCost } from './format.js';
import { html, type PageParts } from './html.js';
import type { PlanView } from './model.js';
import { planTable } from './overview.js';

/**
 * Projects: what exists, what each has cost, and a way in.
 *
 * The detail page renders its plans through the overview's `planTable` rather
 * than a second table shaped like it. Two tables would agree on the day they
 * were written and drift on the day a column was added to one of them.
 */

type PlanWithRollup = PlanView & { costMicrousd: number; taskCounts: Record<string, number> };

export function projectsPage(input: { now: Date; projects: ProjectSummary[] }): PageParts {
  return {
    title: 'projects',
    nav: 'projects',
    live: '/ui/live/projects',
    attention: input.projects.reduce((total, project) => total + project.proposed, 0),
    regions: [{ id: 'projects', html: projectTable(input.projects, input.now) }],
  };
}

export function projectPage(input: {
  now: Date;
  project: ProjectRow;
  plans: PlanWithRollup[];
}): PageParts {
  return {
    title: input.project.name,
    nav: 'projects',
    live: `/ui/live/projects/${input.project.id}`,
    attention: input.plans.filter((plan) => plan.state === 'proposed').length,
    regions: [
      { id: 'project', html: projectCard(input.project, input.plans) },
      { id: 'plans', html: planTable(input.plans) },
    ],
  };
}

function projectTable(projects: ProjectSummary[], now: Date): string {
  if (projects.length === 0) {
    return html`<h2>Projects</h2>
      <p class="empty">No projects yet. One is created the first time a plan names it.</p>`;
  }

  return html`<h2>Projects</h2>
    <table>
      <tr>
        <th>project</th><th>plans</th><th>cost</th>
        <th>last plan update</th><th>repo</th>
      </tr>
      ${projects.map(
        (project) => html`<tr>
          <td>
            <a href="/ui/projects/${project.id}">${project.name}</a>
            <div class="meta"><code>${project.id.slice(0, 8)}</code></div>
          </td>
          <td>
            ${project.plans}
            <div class="meta">${stateCounts(project.states)}</div>
          </td>
          <td>${formatCost(project.costMicrousd)}</td>
          <td class="meta">${ago(now, project.lastPlanUpdate, 'no plans yet')}</td>
          <td class="meta">${project.gitea_repo ?? 'not created yet'}</td>
        </tr>`,
      )}
    </table>`;
}

/**
 * The header of a project page. It carries the four columns the table has and
 * nothing else, because there is nothing else: a project is its name, its repo
 * and when it was created.
 */
function projectCard(project: ProjectRow, plans: PlanWithRollup[]): string {
  const spent = plans.reduce((total, plan) => total + plan.costMicrousd, 0);

  return html`<h2>${project.name}</h2>
    <div class="card">
      <div class="meta">
        <a href="/ui/projects">all projects</a> ·
        <code>${project.id}</code>
      </div>
      <div class="meta">repo: ${project.gitea_repo ?? 'not created yet'}</div>
      <div class="meta">created ${project.created_at.toISOString()}</div>
      <div class="meta">
        ${plans.length} plans · ${formatCost(spent)} spent
      </div>
    </div>`;
}

/** "3 done, 1 running" — the shape of the work, in the width of a cell. */
function stateCounts(states: Record<string, number>): string {
  return Object.entries(states)
    .map(([state, n]) => `${n} ${state}`)
    .join(', ');
}
