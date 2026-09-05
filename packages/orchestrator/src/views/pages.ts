import type { Plan } from '@mycelium/contracts';
import { planTokenCeiling } from '../domain/budget.js';
import type { AlertRow } from '../services/alerts.js';
import type { PlanRow, TaskRow } from '../services/plans.js';
import type { AgentRow } from '../services/supervisorsRegistry.js';
import { escape, html, layout, raw } from './html.js';

/**
 * The two pages. Ordered by what matters: what is waiting on a decision, what
 * broke and has not been acknowledged, then everything else.
 */

interface OverviewInput {
  now: Date;
  proposed: PlanRow[];
  plans: Array<PlanRow & { tokensSpent: number; taskCounts: Record<string, number> }>;
  alerts: AlertRow[];
  workers: Array<AgentRow & { healthy: boolean; planIds: string[] }>;
  healthyWithinMinutes: number;
}

export function overview(input: OverviewInput): string {
  return layout('overview', input.now, [
    needsAttention(input.proposed),
    alertList(input.alerts),
    planTable(input.plans),
    workerTable(input.workers, input.now, input.healthyWithinMinutes),
  ].join(''));
}

function needsAttention(proposed: PlanRow[]): string {
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
function whyNotRunning(plan: PlanRow): string {
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

function planTable(
  plans: Array<PlanRow & { tokensSpent: number; taskCounts: Record<string, number> }>,
): string {
  if (plans.length === 0) return html`<h2>Plans</h2><p class="empty">No plans yet.</p>`;

  return html`<h2>Plans</h2>
    <table>
      <tr><th>plan</th><th>state</th><th>tasks</th><th>tokens</th><th>why</th></tr>
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
          <td>${plan.tokensSpent} / ${planTokenCeiling(spec)}</td>
          <td class="meta">${whyNotRunning(plan)}</td>
        </tr>`;
      })}
    </table>`;
}

function workerTable(
  workers: Array<AgentRow & { healthy: boolean; planIds: string[] }>,
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

interface PlanPageInput {
  now: Date;
  plan: PlanRow;
  tasks: TaskRow[];
  // `ts` is a string on the wire and in the row: the event log stores what the
  // emitter said, and only the orchestrator's own clock produces Dates here.
  events: Array<{ ts: string; type: string; severity: string; payload: unknown }>;
}

export function planPage(input: PlanPageInput): string {
  const { plan } = input;
  const spec = plan.spec as Plan;

  return layout(spec.goal, input.now, [
    html`<h2>${spec.goal}</h2>
      <p class="meta">
        <code>${plan.id}</code> · ${plan.state} · ${plan.env}
        ${plan.terminal_reason === null ? raw('') : raw(html` · ${plan.terminal_reason}`)}
      </p>`,
    actions(plan),
    // Rendered as the questions they are. This is the page where a wrong
    // assumption is caught cheaply, and a list to skim is not that.
    html`<h2>Assumptions — are these true?</h2>
      <ul>${spec.assumptions.map((a) => html`<li>${a}</li>`)}</ul>`,
    html`<h2>Non-goals</h2>
      ${
        (spec.non_goals ?? []).length === 0
          ? raw(html`<p class="empty">None declared. Nothing bounds the agent's scope.</p>`)
          : raw(html`<ul>${(spec.non_goals ?? []).map((g) => html`<li>${g}</li>`)}</ul>`)
      }`,
    html`<h2>Envelope</h2>
      <table>
        <tr><th>tokens</th><td>${planTokenCeiling(spec)}</td></tr>
        <tr><th>concurrency</th><td>${spec.max_concurrent_agents ?? 2}</td></tr>
        <tr><th>environment TTL</th><td>${spec.env_ttl_min ?? 240} min</td></tr>
        <tr><th>egress</th><td>${(spec.egress ?? []).join(', ') || 'none beyond the standing set'}</td></tr>
      </table>`,
    taskTable(input.tasks),
    manifest(plan),
    eventList(input.events),
  ].join(''));
}

function actions(plan: PlanRow): string {
  const buttons: string[] = [];

  if (plan.state === 'proposed') {
    buttons.push(html`<form method="post" action="/ui/plans/${plan.id}/approve"><button>approve</button></form>`);
    buttons.push(html`<form method="post" action="/ui/plans/${plan.id}/reject"><button class="danger">reject</button></form>`);
  }

  // The operator's budget brake on a plan already spending.
  if (['queued', 'provisioning', 'running'].includes(plan.state)) {
    buttons.push(html`<form method="post" action="/ui/plans/${plan.id}/cancel"><button class="danger">cancel</button></form>`);
  }

  return buttons.length === 0 ? '' : `<p>${buttons.join(' ')}</p>`;
}

function taskTable(tasks: TaskRow[]): string {
  if (tasks.length === 0) return '';

  return html`<h2>Tasks</h2>
    <table>
      <tr><th>task</th><th>state</th><th>attempts</th><th>tokens</th><th>error</th></tr>
      ${tasks.map(
        (task) => html`<tr>
          <td>${task.local_id}</td>
          <td>${task.state}</td>
          <td class="meta">${task.execution_attempt} exec / ${task.dispatch_attempt} dispatch</td>
          <td>${task.tokens_spent}</td>
          <td class="meta">${task.error ?? ''}</td>
        </tr>`,
      )}
    </table>`;
}

function manifest(plan: PlanRow): string {
  if (plan.manifest === null || plan.manifest === undefined) return '';
  return html`<h2>Manifest</h2><pre><code>${JSON.stringify(plan.manifest, null, 2)}</code></pre>`;
}

function eventList(
  events: Array<{ ts: string; type: string; severity: string; payload: unknown }>,
): string {
  if (events.length === 0) return html`<h2>Events</h2><p class="empty">Nothing yet.</p>`;

  return html`<h2>Events</h2>
    <table>
      <tr><th>when</th><th>type</th><th>detail</th></tr>
      ${events.map(
        (event) => html`<tr>
          <td class="meta">${event.ts}</td>
          <td>${event.type}</td>
          <td><code>${JSON.stringify(event.payload)}</code></td>
        </tr>`,
      )}
    </table>`;
}

/** Exported for the tests that assert nothing sensitive is rendered. */
export const escapeForTest = escape;
