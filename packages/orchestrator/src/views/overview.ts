import type { Plan } from '@mycelium/contracts';
import { planCostCeiling } from '../domain/budget.js';
import type { AlertRow } from '../services/alerts.js';
import { PLAN_LIST_LIMIT } from '../services/plans.js';
import { formatCost } from './format.js';
import { html, raw, type PageParts } from './html.js';
import type { AgentView, PlanView } from './model.js';

/**
 * The overview. Ordered by what matters: what is waiting on a decision, what
 * broke and has not been acknowledged, then everything else.
 *
 * Every section is a region with a stable id, and a region is emitted even
 * when it is empty. That is not tidiness — a poll replaces the contents of an
 * element it finds by id, so a section that disappears when it has nothing to
 * say could never come back without a reload.
 */

/**
 * Where the plan table is in a longer list. `path` rather than a hardcoded
 * `/ui` because the same table is rendered by the project page, which links
 * to its own url — and one day may page too.
 */
export interface Pager {
  page: number;
  pageCount: number;
  path: string;
}

interface OverviewInput {
  now: Date;
  proposed: PlanView[];
  plans: Array<PlanView & { costMicrousd: number; taskCounts: Record<string, number> }>;
  pager: Pager;
  alerts: AlertRow[];
  workers: Array<AgentView & { planIds: string[] }>;
  healthyWithinMinutes: number;
}

export function overviewPage(input: OverviewInput): PageParts {
  return {
    title: 'overview',
    nav: 'overview',
    // The page has to survive the poll. Without it every refresh would drag
    // the operator back to page 1 five seconds after they left it — the same
    // reason the monitor page carries its `days` here.
    live: `/ui/live/overview?page=${input.pager.page}`,
    attention: input.proposed.length,
    regions: [
      { id: 'attention', html: needsAttention(input.proposed) },
      { id: 'alerts', html: alertList(input.alerts) },
      { id: 'plans', html: planTable(input.plans, input.pager) },
      {
        id: 'workers',
        html: workerTable(input.workers, input.now, input.healthyWithinMinutes),
      },
    ],
  };
}

function needsAttention(proposed: PlanView[]): string {
  if (proposed.length === 0) {
    // This section is loud when it is not empty, so it has to be
    // unmistakably quiet when it is.
    return html`<h2>Needs attention</h2><p class="empty">Nothing is waiting on you.</p>`;
  }

  return html`<h2>Needs attention</h2>${proposed.map(
    (plan) => html`
      <div class="card attention">
        <a href="/ui/plans/${plan.id}"><strong>${(plan.spec as Plan).goal}</strong></a>
        <div class="meta">proposed ${plan.proposed_at.toISOString()} by ${plan.proposed_by}</div>
      </div>`,
  )}`;
}

function alertList(alerts: AlertRow[]): string {
  if (alerts.length === 0) {
    return html`<h2>Alerts</h2><p class="empty">Nothing unacknowledged.</p>`;
  }

  return html`<h2>Alerts</h2>${alerts.map(
    (alert) => html`
      <div class="card alert">
        <strong>${alert.type}</strong>
        <span class="meta">${alert.ts.toISOString()}</span>
        <div><code>${JSON.stringify(alert.payload)}</code></div>
        <div class="meta">
          ${alert.plan_id === null ? raw('') : raw(html`<a href="/ui/plans/${alert.plan_id}">plan</a> · `)}
          <form method="post" action="/ui/alerts/${alert.event_id}/ack">
            <button>acknowledge</button>
          </form>
        </div>
      </div>`,
  )}`;
}

/**
 * A plan that is not running says why. A plan queued with three attempts
 * behind it is a different problem from one nobody has approved, and without
 * this they look identical.
 */
export function whyNotRunning(plan: PlanView): string {
  switch (plan.state) {
    case 'running':
      return '';
    case 'proposed':
      return 'awaiting approval';
    case 'queued':
      if (plan.provision_attempts > 0) {
        const retry =
          plan.next_provision_at === null
            ? 'no retry scheduled'
            : `retry ${plan.next_provision_at.toISOString()}`;
        return `${plan.provision_attempts} provision attempts, ${retry}`;
      }
      return 'waiting for a supervisor';
    case 'provisioning':
      return 'selecting a supervisor';
    default:
      return plan.terminal_reason ?? plan.state;
  }
}

/**
 * Prev/next and where you are. Rendered only when there is more than one
 * page: a pager under a three-row table is noise that says nothing.
 */
function pagerControls(pager: Pager): string {
  if (pager.pageCount <= 1) return '';

  const prev =
    pager.page > 1
      ? html`<a href="${pager.path}?page=${pager.page - 1}">&larr; prev</a>`
      : html`<span class="meta">&larr; prev</span>`;
  const next =
    pager.page < pager.pageCount
      ? html`<a href="${pager.path}?page=${pager.page + 1}">next &rarr;</a>`
      : html`<span class="meta">next &rarr;</span>`;

  return html`<p class="meta">
    ${raw(prev)} · page ${pager.page} of ${pager.pageCount} · ${raw(next)}
  </p>`;
}

/**
 * Exported because the project page shows the same table, and two of them
 * would drift. The project page passes no pager and keeps the old cap
 * behaviour; only the overview pages.
 */
export function planTable(
  plans: Array<PlanView & { costMicrousd: number; taskCounts: Record<string, number> }>,
  pager?: Pager,
): string {
  if (plans.length === 0) {
    // An empty page 2 is a different thing from an empty system, and an
    // operator who lands on one needs the way back rather than "no plans yet".
    const empty =
      pager !== undefined && pager.page > 1
        ? html`<p class="empty">Nothing on this page.</p>${raw(pagerControls(pager))}`
        : html`<p class="empty">No plans yet.</p>`;
    return html`<h2>Plans</h2>${raw(empty)}`;
  }

  // Unpaginated callers still get the truncation warning: a list that is
  // exactly the cap is probably not the whole list, and saying so is the
  // difference between a short history and a truncated one.
  const capped =
    pager !== undefined
      ? pagerControls(pager)
      : plans.length < PLAN_LIST_LIMIT
        ? ''
        : html`<p class="meta">Showing the most recent ${PLAN_LIST_LIMIT}; there may be more.</p>`;

  return html`<h2>Plans</h2>
    <table>
      <tr><th>plan</th><th>state</th><th>tasks</th><th>cost</th><th>why</th></tr>
      ${plans.map((plan) => {
        const spec = plan.spec as Plan;
        const counts = Object.entries(plan.taskCounts)
          .map(([state, n]) => `${n} ${state}`)
          .join(', ');
        return html`<tr>
          <td>
            <a href="/ui/plans/${plan.id}">${spec.goal}</a>
            <div class="meta"><code>${plan.id.slice(0, 8)}</code> · ${plan.env}</div>
          </td>
          <td>${plan.state}</td>
          <td>${counts}</td>
          <td>${formatCost(plan.costMicrousd)} / ${formatCost(planCostCeiling(spec))}</td>
          <td class="meta">${whyNotRunning(plan)}</td>
        </tr>`;
      })}
    </table>${raw(capped)}`;
}

function workerTable(
  workers: Array<AgentView & { planIds: string[] }>,
  now: Date,
  healthyWithinMinutes: number,
): string {
  if (workers.length === 0) {
    return html`<h2>Workers</h2><p class="empty">No supervisor has registered.</p>`;
  }

  return html`<h2>Workers</h2>
    <table>
      <tr><th>name</th><th>env</th><th>health</th><th>last heartbeat</th><th>plans</th></tr>
      ${workers.map((worker) => {
        const since =
          worker.last_heartbeat_at === null
            ? 'never'
            : `${Math.round((now.getTime() - worker.last_heartbeat_at.getTime()) / 1000)}s ago`;
        // An unhealthy VM takes no new dispatch, so naming the plans placed on
        // it is the difference between "a VM is down" and "these plans are stuck".
        const stuck = worker.healthy
          ? `${worker.planIds.length} placed`
          : `${worker.planIds.length} stuck here`;
        return html`<tr>
          <td>${worker.name}</td>
          <td>${worker.env}</td>
          <td>${worker.healthy ? 'healthy' : 'unhealthy'}</td>
          <td class="meta">${since} (stale after ${healthyWithinMinutes}m)</td>
          <td>${stuck}</td>
        </tr>`;
      })}
    </table>`;
}
