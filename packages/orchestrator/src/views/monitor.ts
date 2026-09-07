import type {
  DaySpend,
  FailedPlan,
  Latency,
  MonitorSummary,
  StateCount,
  TaskOutcome,
  WindowDays,
} from '../services/monitor.js';
import { WINDOW_DAYS } from '../services/monitor.js';
import { bar } from './components.js';
import { formatCost } from './format.js';
import { html, raw, type PageParts } from './html.js';

/**
 * The Monitor page: what has run, what failed, and where the cost went.
 *
 * Every section says what its window is *over*. "Spend last week" is not a
 * fact until you know it is keyed on when a task finished — nothing in the
 * schema timestamps cost spend, so that is the nearest honest key and the
 * page says so rather than letting the operator assume otherwise.
 *
 * There is deliberately no event-type histogram beyond warn and error:
 * `events(type)` has no index, `events` is the fastest-growing table here, and
 * that index is a decision about retention (ticket 0008 section 8.3) rather
 * than about a dashboard.
 */

export function monitorPage(input: { now: Date; summary: MonitorSummary }): PageParts {
  const { summary } = input;

  return {
    title: 'monitor',
    nav: 'monitor',
    live: `/ui/live/monitor?days=${summary.days}`,
    attention: summary.proposed,
    regions: [
      { id: 'window', html: windowPicker(summary.days, summary.since) },
      { id: 'throughput', html: throughput(summary.plans, summary.tasks, summary.days) },
      { id: 'spend', html: spend(summary.spend, summary.days) },
      { id: 'latency', html: latency(summary.latency) },
      { id: 'failures', html: failures(summary.failures, summary.days) },
      { id: 'events', html: events(summary.events, summary.days) },
    ],
  };
}

/** Plain links, so the window survives a reload and can be bookmarked. */
function windowPicker(days: WindowDays, since: Date): string {
  return html`<h2>Window</h2>
    <div class="card">
      <div class="row">
        ${WINDOW_DAYS.map(
          (option) => html`<a
            href="/ui/monitor?days=${option}"
            ${raw(option === days ? 'aria-current="page"' : '')}
            >last ${option}d</a
          >`,
        )}
      </div>
      <div class="meta">since ${since.toISOString()}</div>
    </div>`;
}

function throughput(plans: StateCount[], tasks: TaskOutcome[], days: WindowDays): string {
  const planCells = plans.map(
    (row) => html`<div class="kv">
      <span class="k">${row.state}</span><span class="v">${row.n}</span>
    </div>`,
  );

  return html`<h2>Throughput</h2>
    <div class="card">
      <div class="meta">plans proposed in the last ${days}d, by the state they are in now</div>
      ${plans.length === 0
        ? raw(html`<p class="empty">No plans were proposed in this window.</p>`)
        : raw(html`<div class="grid">${planCells}</div>`)}
    </div>
    <div class="card">
      <div class="meta">tasks that finished in the last ${days}d</div>
      ${tasks.length === 0
        ? raw(html`<p class="empty">No tasks finished in this window.</p>`)
        : raw(taskTable(tasks))}
    </div>`;
}

function taskTable(tasks: TaskOutcome[]): string {
  return html`<table>
    <tr>
      <th>outcome</th><th>tasks</th><th>cost</th>
      <th>executions</th><th>dispatches</th>
    </tr>
    ${tasks.map(
      (row) => html`<tr>
        <td>${row.state}</td>
        <td>${row.n}</td>
        <td>${formatCost(row.costMicrousd)}</td>
        <td>${row.executions}</td>
        <td>${row.dispatches}</td>
      </tr>`,
    )}
  </table>`;
}

/**
 * Spend per day, bucketed on `tasks.finished_at` in UTC. The bars are relative
 * to the biggest day in the window rather than to a budget: there is no budget
 * column, and drawing one against an invented ceiling would be a fiction.
 */
function spend(series: DaySpend[], days: WindowDays): string {
  const total = series.reduce((sum, day) => sum + day.costMicrousd, 0);

  if (series.length === 0) {
    return html`<h2>Spend</h2>
      <div class="card">
        <div class="meta">cost, by task finish (UTC), last ${days}d</div>
        <p class="empty">No tasks finished in this window, so nothing has been attributed.</p>
      </div>`;
  }

  const peak = Math.max(...series.map((day) => day.costMicrousd));

  return html`<h2>Spend</h2>
    <div class="card">
      <div class="meta">
        ${formatCost(total)}, by task finish (UTC), last ${days}d
      </div>
      ${raw(sparkline(series))}
      <table>
        <tr><th>day</th><th>cost</th><th></th></tr>
        ${series.map(
          (day) => html`<tr>
            <td>${day.day}</td>
            <td>${formatCost(day.costMicrousd)}</td>
            <td>${raw(bar(peak === 0 ? 0 : (day.costMicrousd / peak) * 100))}</td>
          </tr>`,
        )}
      </table>
    </div>`;
}

/**
 * The shape of the window at a glance, computed here rather than drawn by a
 * charting library: it is a polyline over at most 30 points, and a dependency
 * would be larger than the page it drew on.
 */
function sparkline(series: DaySpend[]): string {
  if (series.length < 2) return '';

  // Relative-to-peak and therefore unit-agnostic: only the labels below
  // changed when this became a cost figure rather than a token count.
  const peak = Math.max(...series.map((day) => day.costMicrousd));
  const step = 100 / (series.length - 1);
  const points = series
    .map((day, index) => {
      // Flat rather than divided by zero when every day in the window is zero.
      const height = peak === 0 ? 0 : (day.costMicrousd / peak) * 20;
      return `${(index * step).toFixed(1)},${(22 - height).toFixed(1)}`;
    })
    .join(' ');

  return `<svg class="spark" viewBox="0 0 100 24" preserveAspectRatio="none" role="img"
    aria-label="cost per day across the window"><polyline points="${points}"
    fill="none" stroke="currentColor" stroke-width="1.2"/></svg>`;
}

function latency(times: Latency): string {
  return html`<h2>Latency</h2>
    <div class="card">
      <div class="meta">
        median and tail, over the same window. Discrete percentiles: each is a
        duration that actually occurred, not an interpolation between two that did.
      </div>
      <div class="grid">
        <div class="kv"><span class="k">task p50</span><span class="v">${seconds(times.task_p50)}</span></div>
        <div class="kv"><span class="k">task p95</span><span class="v">${seconds(times.task_p95)}</span></div>
        <div class="kv"><span class="k">approval p50</span><span class="v">${seconds(times.approval_p50)}</span></div>
        <div class="kv"><span class="k">approval p95</span><span class="v">${seconds(times.approval_p95)}</span></div>
      </div>
    </div>`;
}

function failures(plans: FailedPlan[], days: WindowDays): string {
  if (plans.length === 0) {
    return html`<h2>Failures</h2>
      <div class="card">
        <div class="meta">plans that failed or were cancelled in the last ${days}d</div>
        <p class="empty">Nothing failed in this window.</p>
      </div>`;
  }

  return html`<h2>Failures</h2>
    <table>
      <tr><th>plan</th><th>state</th><th>reason</th><th>provision attempts</th><th>when</th></tr>
      ${plans.map(
        (plan) => html`<tr>
          <td><a href="/ui/plans/${plan.id}">${plan.goal ?? plan.id}</a></td>
          <td>${plan.state}</td>
          <td class="meta">${plan.terminal_reason ?? 'not recorded'}</td>
          <td>${plan.provision_attempts}</td>
          <td class="meta">${plan.updated_at.toISOString()}</td>
        </tr>`,
      )}
    </table>`;
}

/**
 * Warn and error events by type. A superset of the alert list on purpose: the
 * alert rule filters warn events on their payload, which a GROUP BY cannot do,
 * so this counts every warn and error and says that is what it counted.
 */
function events(counts: StateCount[], days: WindowDays): string {
  if (counts.length === 0) {
    return html`<h2>Warnings and errors</h2>
      <div class="card">
        <div class="meta">by event type, last ${days}d</div>
        <p class="empty">Nothing was logged at warn or error in this window.</p>
      </div>`;
  }

  return html`<h2>Warnings and errors</h2>
    <div class="card">
      <div class="meta">
        by event type, last ${days}d. A superset of the alert list: some warn
        types only count as alerts depending on their payload.
      </div>
      <table>
        <tr><th>type</th><th>events</th></tr>
        ${counts.map(
          (row) => html`<tr><td>${row.state}</td><td>${row.n}</td></tr>`,
        )}
      </table>
    </div>`;
}

/** A duration nobody has to convert in their head, and a dash when there is none. */
function seconds(value: number | null): string {
  if (value === null) return '—';
  if (value < 90) return `${value}s`;
  if (value < 5400) return `${Math.round(value / 60)}m`;
  return `${(value / 3600).toFixed(1)}h`;
}
