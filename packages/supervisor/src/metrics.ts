import fs from 'node:fs/promises';
import os from 'node:os';
import type { SupervisorConfig } from './config.js';
import type { Ledger } from './environments/ledger.js';

/**
 * What this VM looks like right now, for the heartbeat and for /healthz.
 *
 * Deliberately not `docker stats`: this runs on the path that keeps the VM
 * eligible for dispatch, and shelling out to the container runtime every
 * thirty seconds to answer a dashboard is the wrong trade. Everything here
 * comes from `os` and two file reads.
 *
 * The collector's contract is that it always resolves. A field it cannot
 * answer is `null`; it never throws, because a thrown heartbeat is a VM that
 * stops receiving work.
 */

export interface HostMetrics {
  uptime_sec: number;
  cpu_count: number;
  load_1: number;
  load_5: number;
  load_15: number;
  /** load_1 / cpu_count — one number, and the only one worth a bar. */
  cpu_saturation: number;
  mem_total_mb: number;
  mem_available_mb: number;
  mem_used_pct: number;
  disk_total_mb: number | null;
  disk_free_mb: number | null;
  disk_used_pct: number | null;
  environments: number;
  environment_capacity: number;
  sandboxes: number;
  version: string;
}

/** The parts of `fs.statfs`'s answer this needs. */
export interface StatFs {
  blocks: number;
  bfree: number;
  bavail: number;
  bsize: number;
}

export interface MetricsSources {
  ledger: Ledger;
  config: Pick<SupervisorConfig, 'maxEnvironments'>;
  /** Injected so tests stay hermetic and can exercise the failure path. */
  statfs?: (path: string) => Promise<StatFs>;
  readMemInfo?: () => Promise<string>;
}

const MB = 1024 * 1024;
const VERSION = process.env.MYCELIUM_VERSION ?? 'dev';

export async function collectHostMetrics(sources: MetricsSources): Promise<HostMetrics> {
  const [load1 = 0, load5 = 0, load15 = 0] = os.loadavg();
  const cpuCount = Math.max(os.cpus().length, 1);

  const memTotal = os.totalmem();
  const memAvailable = await availableMemory(sources, memTotal);
  const disk = await diskUsage(sources);

  return {
    uptime_sec: Math.round(os.uptime()),
    cpu_count: cpuCount,
    load_1: load1,
    load_5: load5,
    load_15: load15,
    // On Windows loadavg() is all zeros, so this reads 0 on the dev box. That
    // is honest — there is no load average to report — and the VMs are Linux.
    cpu_saturation: load1 / cpuCount,
    mem_total_mb: memTotal / MB,
    mem_available_mb: memAvailable / MB,
    mem_used_pct: memTotal > 0 ? clampPercent(((memTotal - memAvailable) / memTotal) * 100) : 0,
    disk_total_mb: disk.total,
    disk_free_mb: disk.free,
    disk_used_pct: disk.usedPct,
    // Reported from the in-memory ledger, which is the supervisor's own view
    // and is not verified against the VM. The dashboard labels it as reported.
    environments: sources.ledger.size,
    environment_capacity: sources.config.maxEnvironments,
    sandboxes: sources.ledger.list().reduce((total, env) => total + env.sandboxes.size, 0),
    version: VERSION,
  };
}

/**
 * `os.freemem()` excludes reclaimable page cache, so a perfectly healthy Linux
 * VM reports 85–95% used and the operator learns to ignore the bar — worse
 * than not having one. `MemAvailable` is the kernel's own answer to "how much
 * could a new process actually get", so it is preferred where it exists.
 */
async function availableMemory(sources: MetricsSources, total: number): Promise<number> {
  const read = sources.readMemInfo ?? (() => fs.readFile('/proc/meminfo', 'utf8'));

  try {
    const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(await read());
    if (match?.[1] !== undefined) {
      const bytes = Number(match[1]) * 1024;
      if (Number.isFinite(bytes) && bytes >= 0 && bytes <= total) return bytes;
    }
  } catch {
    // No /proc, which is every non-Linux host. Fall through.
  }

  return os.freemem();
}

async function diskUsage(
  sources: MetricsSources,
): Promise<{ total: number | null; free: number | null; usedPct: number | null }> {
  const statfs = sources.statfs ?? ((path: string) => fs.statfs(path) as Promise<StatFs>);
  const empty = { total: null, free: null, usedPct: null };

  try {
    const stat = await statfs(os.tmpdir());
    const total = stat.blocks * stat.bsize;
    const free = stat.bavail * stat.bsize;
    // A zero-block filesystem is not a full one. Reporting 100% here would
    // page someone about a number that means nothing.
    if (!Number.isFinite(total) || total <= 0) return empty;

    return {
      total: total / MB,
      free: free / MB,
      usedPct: clampPercent(((total - free) / total) * 100),
    };
  } catch {
    // statfs is not on every platform or every mount. Only the disk fields go
    // missing; the rest of the report still lands.
    return empty;
  }
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 100);
}
