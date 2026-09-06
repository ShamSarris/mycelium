import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { heartbeatOnce } from '../src/loops.js';
import { buildTestApp, type TestHarness } from './helpers/app.js';

let h: TestHarness;

beforeAll(async () => {
  h = await buildTestApp();
});

afterAll(async () => {
  await h.close();
});

beforeEach(() => {
  h.reset();
});

describe('heartbeatOnce', () => {
  it('reports to the orchestrator', async () => {
    expect(await heartbeatOnce(h.deps)).toBe(true);
    expect(h.orchestrator.heartbeats).toHaveLength(1);
  });

  it('is configured for the thirty seconds baseline section 10 names', () => {
    expect(h.config.heartbeatIntervalMs).toBe(30_000);
  });

  // Losing the heartbeat costs this VM new dispatch, which is recoverable.
  // Losing the process costs the plans already running on it, which is not.
  it('records a failure and keeps the daemon alive', async () => {
    h.orchestrator.heartbeat = async () => {
      throw new Error('connect ECONNREFUSED');
    };

    expect(await heartbeatOnce(h.deps)).toBe(false);
    expect(h.events.ofType('error')).toHaveLength(1);
    expect(h.events.ofType('error')[0]?.payload).toMatchObject({ stage: 'heartbeat' });
  });
});

describe('the metrics the heartbeat carries', () => {
  it('sends a report on the machine', async () => {
    await heartbeatOnce(h.deps);

    const [metrics] = h.orchestrator.metrics;
    expect(metrics?.cpu_count).toBeGreaterThan(0);
    expect(metrics?.environment_capacity).toBe(h.config.maxEnvironments);
  });

  // Collecting metrics is the newest thing on the path that keeps this VM
  // eligible for dispatch, and it reads the filesystem. It must never be the
  // reason a working VM stops receiving work.
  it('still heartbeats when the collector throws', async () => {
    h.deps.metrics = async () => {
      throw new Error('statfs exploded');
    };

    expect(await heartbeatOnce(h.deps)).toBe(true);
    expect(h.orchestrator.heartbeats).toHaveLength(1);
    expect(h.orchestrator.metrics[0]).toBeUndefined();
  });
});
