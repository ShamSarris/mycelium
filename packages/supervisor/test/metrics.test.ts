import { describe, expect, it } from 'vitest';
import { Ledger } from '../src/environments/ledger.js';
import { collectHostMetrics } from '../src/metrics.js';

/**
 * This runs on whatever machine the suite runs on, including the Windows dev
 * box, so it asserts that every number is a number rather than asserting any
 * particular value. The thing that would actually break in production is a
 * collector that throws or returns NaN, and both are checked here.
 */

function ledgerWith(count: number): Ledger {
  const ledger = new Ledger();
  for (let i = 0; i < count; i += 1) {
    ledger.add({
      planId: `plan-${i}`,
      state: 'running',
      root: '/tmp',
      workdir: '/tmp',
      agent: {} as never,
      network: 'net',
      proxyUrl: 'http://127.0.0.1:1',
      brokerSocket: '/tmp/sock',
      egress: [],
      ttlExpiresAt: new Date(),
      sandboxes: new Set(['a', 'b']),
    });
  }
  return ledger;
}

const CONFIG = { maxEnvironments: 2 } as never;

describe('collectHostMetrics', () => {
  it('reports finite numbers for every field this machine can answer', async () => {
    const metrics = await collectHostMetrics({ ledger: new Ledger(), config: CONFIG });

    for (const key of [
      'uptime_sec',
      'cpu_count',
      'load_1',
      'load_5',
      'load_15',
      'cpu_saturation',
      'mem_total_mb',
      'mem_available_mb',
      'mem_used_pct',
    ] as const) {
      expect(Number.isFinite(metrics[key]), key).toBe(true);
      expect(metrics[key], key).toBeGreaterThanOrEqual(0);
    }
  });

  it('derives saturation from load against core count', async () => {
    const metrics = await collectHostMetrics({ ledger: new Ledger(), config: CONFIG });

    expect(metrics.cpu_saturation).toBeCloseTo(metrics.load_1 / metrics.cpu_count, 6);
  });

  it('reports memory used as a percentage of total, not of free', async () => {
    const metrics = await collectHostMetrics({ ledger: new Ledger(), config: CONFIG });

    expect(metrics.mem_used_pct).toBeLessThanOrEqual(100);
    expect(metrics.mem_available_mb).toBeLessThanOrEqual(metrics.mem_total_mb);
  });

  it('counts environments and sandboxes from the ledger', async () => {
    const metrics = await collectHostMetrics({ ledger: ledgerWith(2), config: CONFIG });

    expect(metrics.environments).toBe(2);
    expect(metrics.environment_capacity).toBe(2);
    expect(metrics.sandboxes).toBe(4);
  });

  it('nulls only the disk fields when the filesystem cannot be read', async () => {
    const metrics = await collectHostMetrics({
      ledger: new Ledger(),
      config: CONFIG,
      statfs: async () => {
        throw new Error('ENOENT');
      },
    });

    expect(metrics.disk_total_mb).toBeNull();
    expect(metrics.disk_free_mb).toBeNull();
    expect(metrics.disk_used_pct).toBeNull();
    // The point of the try/catch: everything else still gets reported.
    expect(Number.isFinite(metrics.cpu_count)).toBe(true);
  });

  it('reports disk from statfs when it answers', async () => {
    const metrics = await collectHostMetrics({
      ledger: new Ledger(),
      config: CONFIG,
      statfs: async () => ({ blocks: 1000, bfree: 250, bavail: 250, bsize: 1024 * 1024 }),
    });

    expect(metrics.disk_total_mb).toBe(1000);
    expect(metrics.disk_free_mb).toBe(250);
    expect(metrics.disk_used_pct).toBe(75);
  });

  it('prefers MemAvailable over free memory when /proc is readable', async () => {
    const metrics = await collectHostMetrics({
      ledger: new Ledger(),
      config: CONFIG,
      readMemInfo: async () => 'MemTotal:  8000000 kB\nMemFree: 100000 kB\nMemAvailable: 4000000 kB\n',
    });

    // os.freemem() excludes reclaimable page cache and would show a healthy VM
    // near 99% used. An operator who learns to ignore the bar is worse off
    // than one who never had it.
    expect(metrics.mem_available_mb).toBeCloseTo(4000000 / 1024, 3);
  });

  it('falls back to os.freemem when /proc/meminfo is not there', async () => {
    const metrics = await collectHostMetrics({
      ledger: new Ledger(),
      config: CONFIG,
      readMemInfo: async () => {
        throw new Error('ENOENT');
      },
    });

    expect(Number.isFinite(metrics.mem_available_mb)).toBe(true);
  });

  it('never throws, because a heartbeat that fails costs the VM its dispatch', async () => {
    await expect(
      collectHostMetrics({
        ledger: new Ledger(),
        config: CONFIG,
        statfs: async () => ({ blocks: 0, bfree: 0, bavail: 0, bsize: 0 }),
        readMemInfo: async () => 'nonsense',
      }),
    ).resolves.toBeDefined();
  });

  it('does not report a division by zero as a disk usage', async () => {
    const metrics = await collectHostMetrics({
      ledger: new Ledger(),
      config: CONFIG,
      statfs: async () => ({ blocks: 0, bfree: 0, bavail: 0, bsize: 4096 }),
    });

    expect(metrics.disk_used_pct).toBeNull();
  });
});
