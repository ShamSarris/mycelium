import type { Plan } from '@mycelium/contracts';
import { planTokenCeiling } from '../domain/budget.js';
import type { TaskRow } from '../services/plans.js';
import { html, raw, type PageParts } from './html.js';
import type { PlanView } from './model.js';

/**
 * One plan: everything the approval gate covers, then what it has done.
 *
 * As on the overview, every region is emitted even when empty — a plan with no
 * manifest yet must still have somewhere to put one when it finishes, or the
 * poll would have nothing to fill.
 */

interface PlanPageInput {
  now: Date;
  plan: PlanView;
  tasks: TaskRow[];
  // `ts` is a string on the wire and in the row: the event log stores what the
  // emitter said, and only the orchestrator's own clock produces Dates here.
  events: Array<{ ts: string; type: string; severity: string; payload: unknown }>;
}

export function planPage(input: PlanPageInput): PageParts {
  const { plan } = input;
  const spec = plan.spec as Plan;

  return {
    title: spec.goal,
    // A plan belongs to the overview; it is not a fifth tab.
    nav: 'overview',
    live: `/ui/live/plans/${plan.id}`,
    // Scoped to this plan rather than the whole system: the badge should mean
    // "this page is waiting on you", not "somewhere else something is".
    attention: plan.state === 'proposed' ? 1 : 0,
    regions: [
      { id: 'header', html: header(plan, spec) },
      { id: 'actions', html: actions(plan) },
      { id: 'assumptions', html: assumptions(spec) },
      { id: 'non-goals', html: nonGoals(spec) },
      { id: 'envelope', html: envelope(spec) },
      { id: 'tasks', html: taskTable(input.tasks) },
      { id: 'manifest', html: manifest(plan) },
      { id: 'events', html: eventList(input.events) },
    ],
  };
}

function header(plan: PlanView, spec: Plan): string {
  return html`<h2>${spec.goal}</h2>
    <p class="meta">
      <code>${plan.id}</code> · ${plan.state} · ${plan.env}
      ${plan.terminal_reason === null ? raw('') : raw(html` · ${plan.terminal_reason}`)}
    </p>`;
}

function assumptions(spec: Plan): string {
  // Rendered as the questions they are. This is the page where a wrong
  // assumption is caught cheaply, and a list to skim is not that.
  return html`<h2>Assumptions — are these true?</h2>
    <ul>${spec.assumptions.map((a) => html`<li>${a}</li>`)}</ul>`;
}

function nonGoals(spec: Plan): string {
  const goals = spec.non_goals ?? [];
  return html`<h2>Non-goals</h2>
    ${
      goals.length === 0
        ? raw(html`<p class="empty">None declared. Nothing bounds the agent's scope.</p>`)
        : raw(html`<ul>${goals.map((g) => html`<li>${g}</li>`)}</ul>`)
    }`;
}

function envelope(spec: Plan): string {
  // Raw integers, deliberately: the ceiling is compared against the plan
  // document and against the agent's own refusal message, and a thousands
  // separator would make those three disagree on sight.
  return html`<h2>Envelope</h2>
    <table>
      <tr><th>tokens</th><td>${planTokenCeiling(spec)}</td></tr>
      <tr><th>concurrency</th><td>${spec.max_concurrent_agents ?? 2}</td></tr>
      <tr><th>environment TTL</th><td>${spec.env_ttl_min ?? 240} min</td></tr>
      <tr><th>egress</th><td>${(spec.egress ?? []).join(', ') || 'none beyond the standing set'}</td></tr>
    </table>`;
}

function actions(plan: PlanView): string {
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

function manifest(plan: PlanView): string {
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
