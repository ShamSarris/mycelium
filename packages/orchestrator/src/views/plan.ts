import type { Plan } from '@mycelium/contracts';
import { planCostCeiling } from '../domain/budget.js';
import type { SubagentActivity } from '../services/events.js';
import type { TaskRow } from '../services/plans.js';
import { formatCost } from './format.js';
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
  subagents: SubagentActivity;
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
      { id: 'subagents', html: subagentSection(input.subagents) },
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
  // This used to read: "Raw integers, deliberately: the ceiling is compared
  // against the plan document and against the agent's own refusal message,
  // and a thousands separator would make those three disagree on sight."
  //
  // That rationale has inverted rather than gone away — it is why this
  // comment is rewritten and not deleted. A plan document written in
  // microusd (`max_cost_microusd`) and a dashboard reading `$4.20` are
  // *meant* to look different: the document is the unit an agent enforces
  // against, and this table is what an operator reads, so formatting through
  // `formatCost` is the correct choice for the same reason raw integers used
  // to be.
  //
  // `max_concurrent_agents` no longer has a row here: ticket 03 removed it
  // from the plan schema entirely (the SDK enforces subagent concurrency and
  // the supervisor derives the number from the VM's memory — ticket 13), so
  // there is no longer an operator-authored value to show.
  return html`<h2>Envelope</h2>
    <table>
      <tr><th>cost ceiling</th><td>${formatCost(planCostCeiling(spec))}</td></tr>
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
      <tr><th>task</th><th>state</th><th>attempts</th><th>cost</th><th>error</th></tr>
      ${tasks.map(
        (task) => html`<tr>
          <td>${task.local_id}</td>
          <td>${task.state}</td>
          <td class="meta">${task.execution_attempt} exec / ${task.dispatch_attempt} dispatch</td>
          <td>${formatCost(task.cost_spent_microusd)}</td>
          <td class="meta">${task.error ?? ''}</td>
        </tr>`,
      )}
    </table>`;
}

/**
 * What the plan's own agent delegated, and to what.
 *
 * Two halves, because they answer two different questions. The roster is the
 * definition — the description, tools, effort and prompt the agent was
 * configured with — and it is here because it is written down nowhere else
 * an operator can reach: Mycelium's subagents are worker code, not
 * `.claude/agents/*.md` files, and the SDK is deliberately started with
 * `settingSources: []` so the plan checkout cannot define one. The runs are
 * what actually happened.
 *
 * There is no cost column, and that is not an omission. The SDK reports
 * spend by model, never by subagent, so any per-subagent figure here would
 * be apportioned — and a made-up number on the page an operator uses to
 * judge whether a plan is worth its budget is worse than no number.
 */
function subagentSection(activity: SubagentActivity): string {
  const { roster, runs } = activity;

  if (roster.length === 0 && runs.length === 0) {
    return html`<h2>Subagents</h2>
      <p class="empty">None. This plan's agent has not reported a subagent roster.</p>`;
  }

  return html`<h2>Subagents</h2>${raw(rosterList(roster))}${raw(runList(runs))}`;
}

function rosterList(roster: SubagentActivity['roster']): string {
  if (roster.length === 0) return '';

  return html`<table>
      <tr><th>agent</th><th>tools</th><th>effort</th><th>definition</th></tr>
      ${roster.map(
        (spec) => html`<tr>
          <td><strong>${spec.name}</strong></td>
          <td class="meta">${spec.tools.join(', ')}</td>
          <td class="meta">${spec.effort}</td>
          <td>
            ${spec.description}
            <details><summary class="meta">prompt</summary><pre><code>${spec.prompt}</code></pre></details>
          </td>
        </tr>`,
      )}
    </table>`;
}

function runList(runs: SubagentActivity['runs']): string {
  if (runs.length === 0) {
    return html`<p class="empty">The agent has not spawned one yet.</p>`;
  }

  return html`<table>
      <tr><th>id</th><th>agent</th><th>state</th><th>ran for</th><th>work</th><th>reported</th></tr>
      ${runs.map(
        (run) => html`<tr>
          <td class="meta"><code>${run.id}</code></td>
          <td>${run.type}</td>
          <td>${run.running ? 'running' : 'finished'}</td>
          <td class="meta">${formatDuration(run.durationMs)}</td>
          <td class="meta">${run.toolCalls} tool call${run.toolCalls === 1 ? '' : 's'}</td>
          <td>${run.lastMessage ?? ''}</td>
        </tr>`,
      )}
    </table>`;
}

/**
 * Seconds to one decimal. A subagent's whole point is that it is short —
 * minutes would round every useful difference away, and raw milliseconds
 * make an operator do arithmetic to compare two rows.
 */
function formatDuration(ms: number | null): string {
  if (ms === null) return '';
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${String(Math.round((ms % 60_000) / 1000))}s`;
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
