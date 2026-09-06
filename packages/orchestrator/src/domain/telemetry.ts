/**
 * What a supervisor is allowed to say about the machine it runs on.
 *
 * The heartbeat body arrives from a semi-trusted peer and lands in a jsonb
 * column that the Servers page renders. Postgres will happily store whatever
 * shape it is handed, so this is the only place the shape is decided. It
 * **builds a new object from an allowlist** rather than filtering the input:
 * a key nobody named here cannot reach the column, and therefore cannot reach
 * the operator's screen.
 *
 * A pure function with no database in the way, following `domain/alerts.ts`
 * rather than adding a schema to the contracts package's separate generate
 * step. It never throws: a malformed report must degrade to "no telemetry",
 * never take down the heartbeat that keeps a working VM eligible for dispatch.
 */

export interface HostMetrics {
  uptime_sec?: number;
  cpu_count?: number;
  load_1?: number;
  load_5?: number;
  load_15?: number;
  /** load_1 / cpu_count. The one number worth a bar; legitimately exceeds 1. */
  cpu_saturation?: number;
  mem_total_mb?: number;
  mem_available_mb?: number;
  mem_used_pct?: number;
  disk_total_mb?: number;
  disk_free_mb?: number;
  disk_used_pct?: number;
  /** Reported by the supervisor's in-memory ledger, not verified from here. */
  environments?: number;
  environment_capacity?: number;
  sandboxes?: number;
  version?: string;
}

/** Every field is optional, so a partly-upgraded fleet reports what it can. */
const NUMBERS = [
  'uptime_sec',
  'cpu_count',
  'load_1',
  'load_5',
  'load_15',
  'cpu_saturation',
  'mem_total_mb',
  'mem_available_mb',
  'disk_total_mb',
  'disk_free_mb',
  'environments',
  'environment_capacity',
  'sandboxes',
] as const;

/** Clamped rather than dropped: a reading of 101% is wrong, but not a lie. */
const PERCENTAGES = ['mem_used_pct', 'disk_used_pct'] as const;

/** Long enough for a git describe, short enough not to break the table. */
const MAX_VERSION = 32;

/**
 * Returns `null` when nothing recognisable survived — which is what an
 * un-upgraded supervisor's `{}` produces, and what lets the UPDATE's coalesce
 * leave real telemetry in place rather than overwriting it with nothing.
 */
export function parseHostMetrics(raw: unknown): HostMetrics | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;

  const metrics: HostMetrics = {};

  for (const key of NUMBERS) {
    const value = nonNegative(input[key]);
    if (value !== undefined) metrics[key] = value;
  }

  for (const key of PERCENTAGES) {
    const value = nonNegative(input[key]);
    if (value !== undefined) metrics[key] = Math.min(value, 100);
  }

  const version = input.version;
  if (typeof version === 'string' && version.trim().length > 0) {
    metrics.version = version.trim().slice(0, MAX_VERSION);
  }

  return Object.keys(metrics).length === 0 ? null : metrics;
}

/**
 * Rejects strings that look like numbers as well as NaN and the infinities.
 * A supervisor that sends `"7"` has a bug worth seeing as missing data rather
 * than papering over with a coercion.
 */
function nonNegative(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}
