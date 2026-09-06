import type { Plan } from '@mycelium/contracts';
import type { HostMetrics } from '../domain/telemetry.js';
import { ago, bar, loadTone, pill } from './components.js';
import { html, raw, type PageParts } from './html.js';
import type { AgentView, PlanView } from './model.js';

/**
 * The Servers page: one card per worker VM.
 *
 * Two honesty rules shape almost everything here. The orchestrator has no
 * environments table, so every number under "reported" is the supervisor's
 * in-memory ledger talking about itself — a claim, not a fact. And a
 * supervisor that predates migration 0003, or one whose collector is failing,
 * heartbeats without reporting: rendering that as zeros would describe an idle
 * machine rather than an unknown one, and the metrics age is shown beside the
 * heartbeat age so alive-but-silent cannot pass for fresh.
 */

export type ServerView = AgentView & { plans: PlanView[] };

export function serversPage(input: {
  now: Date;
  servers: ServerView[];
  healthyWithinMinutes: number;
  attention: number;
}): PageParts {
  return {
    title: 'servers',
    nav: 'servers',
    live: '/ui/live/servers',
    attention: input.attention,
    regions: [
      {
        id: 'servers',
        html: serverList(input.servers, input.now, input.healthyWithinMinutes),
      },
    ],
  };
}

function serverList(servers: ServerView[], now: Date, healthyWithinMinutes: number): string {
  if (servers.length === 0) {
    return html`<h2>Servers</h2>
      <p class="empty">No supervisor has registered. Registration is an operator act,
        so a VM cannot join by asking.</p>`;
  }

  return html`<h2>Servers</h2>${servers.map((server) =>
    serverCard(server, now, healthyWithinMinutes),
  )}`;
}

function serverCard(server: ServerView, now: Date, healthyWithinMinutes: number): string {
  const health = server.healthy ? pill('healthy', 'ok') : pill('unhealthy', 'bad');
  // Disabled is an operator decision, not a fault, so it is stated rather than
  // coloured — but it has to be stated, or a VM that never takes work looks
  // like a VM that is broken.
  const enabled = server.enabled ? '' : pill('disabled', 'warn');

  return html`<div class="card${server.healthy ? '' : ' alert'}">
    <div class="server">
      <span class="name">${server.name}</span>
      ${raw(health)}${raw(enabled)}
      <span class="meta">${server.env} · priority ${server.priority}</span>
    </div>
    <div class="meta">
      heartbeat ${ago(now, server.last_heartbeat_at)} (stale after ${healthyWithinMinutes}m)
      · telemetry ${ago(now, server.last_metrics_at, 'never reported')}
      · <code>${server.base_url}</code>
    </div>
    ${raw(placedPlans(server))}
    ${raw(metricsGrid(server.last_metrics))}
  </div>`;
}

/**
 * An unhealthy VM takes no new dispatch, so what is already on it is stranded
 * rather than merely slow. Naming those plans is the difference between "a VM
 * is down" and "these plans are not going to finish".
 */
function placedPlans(server: ServerView): string {
  if (server.plans.length === 0) {
    return html`<div class="meta">nothing placed here</div>`;
  }

  const heading = server.healthy
    ? `${server.plans.length} placed here`
    : `${server.plans.length} stuck here`;

  return html`<div class="meta">${heading}</div>
    <ul>
      ${server.plans.map(
        (plan) => html`<li>
          <a href="/ui/plans/${plan.id}">${(plan.spec as Plan).goal}</a>
          <span class="meta">${plan.state}</span>
        </li>`,
      )}
    </ul>`;
}

function metricsGrid(metrics: HostMetrics | null): string {
  if (metrics === null || Object.keys(metrics).length === 0) {
    return html`<p class="empty">No telemetry — this supervisor predates migration 0003,
      or its metrics collection is failing. It is still heartbeating.</p>`;
  }

  const cells: string[] = [];

  if (metrics.cpu_saturation !== undefined) {
    // Load per core. Above 1.0 the machine is oversubscribed, which is the
    // whole reason this is a ratio rather than a raw load average.
    const percent = metrics.cpu_saturation * 100;
    cells.push(
      cell(
        'cpu saturation',
        html`${metrics.cpu_saturation.toFixed(2)} ${raw(bar(percent, loadTone(percent)))}`,
      ),
    );
  }
  if (metrics.load_1 !== undefined) {
    const rest = [metrics.load_5, metrics.load_15]
      .filter((value): value is number => value !== undefined)
      .map((value) => value.toFixed(2));
    cells.push(cell('load', html`${[metrics.load_1.toFixed(2), ...rest].join(' ')}`));
  }
  if (metrics.cpu_count !== undefined) cells.push(cell('cores', html`${metrics.cpu_count}`));

  if (metrics.mem_used_pct !== undefined) {
    const total =
      metrics.mem_total_mb === undefined ? '' : ` of ${gb(metrics.mem_total_mb)}`;
    cells.push(
      cell(
        'memory',
        html`${Math.round(metrics.mem_used_pct)}%${total}
          ${raw(bar(metrics.mem_used_pct, loadTone(metrics.mem_used_pct)))}`,
      ),
    );
  }
  if (metrics.disk_used_pct !== undefined) {
    const free = metrics.disk_free_mb === undefined ? '' : ` (${gb(metrics.disk_free_mb)} free)`;
    cells.push(
      cell(
        'disk',
        html`${Math.round(metrics.disk_used_pct)}%${free}
          ${raw(bar(metrics.disk_used_pct, loadTone(metrics.disk_used_pct)))}`,
      ),
    );
  }

  if (metrics.environments !== undefined) {
    const capacity =
      metrics.environment_capacity === undefined ? '' : ` / ${metrics.environment_capacity}`;
    cells.push(cell('environments (reported)', html`${metrics.environments}${capacity}`));
  }
  if (metrics.sandboxes !== undefined) {
    cells.push(cell('sandboxes (reported)', html`${metrics.sandboxes}`));
  }
  if (metrics.uptime_sec !== undefined) {
    cells.push(cell('uptime', html`${uptime(metrics.uptime_sec)}`));
  }
  // The one field a supervisor supplies as free text rather than a number, so
  // the only one where the escaper is load-bearing.
  if (metrics.version !== undefined) cells.push(cell('version', html`${metrics.version}`));

  return html`<div class="grid">${cells}</div>`;
}

/** Takes already-escaped markup — every caller builds its value with `html`. */
function cell(label: string, markup: string): string {
  return html`<div class="kv">
    <span class="k">${label}</span><span class="v">${raw(markup)}</span>
  </div>`;
}

function gb(megabytes: number): string {
  return `${(megabytes / 1024).toFixed(1)} GB`;
}

function uptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  return days > 0 ? `${days}d ${hours}h` : `${hours}h`;
}
