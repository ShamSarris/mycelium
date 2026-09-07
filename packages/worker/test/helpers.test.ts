import { stat } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { HostLoopRunner } from '../src/runner/host-loop.js';
import { buildTestWorker, taskDispatch, type TestWorker } from './helpers/agent.js';

/**
 * The harness is what every later work package is tested through, so it gets
 * its own assertions rather than being trusted implicitly.
 */

let h: TestWorker;

afterEach(async () => {
  await h?.close();
});

describe('buildTestWorker', () => {
  it('gives each agent a real workdir and run directory', async () => {
    h = await buildTestWorker();

    expect((await stat(h.workdir)).isDirectory()).toBe(true);
    expect((await stat(h.runDir)).isDirectory()).toBe(true);
    expect(h.config.workdir).toBe(h.workdir);
  });

  it('wires the four fakes into deps', async () => {
    h = await buildTestWorker();

    // The transport is no longer a `Deps` field (ticket 09) — it is wrapped
    // inside `deps.runner`, which is what this checks instead.
    expect(h.deps.runner).toBeInstanceOf(HostLoopRunner);
    expect(h.deps.broker).toBe(h.broker);
    expect(h.deps.orchestrator).toBe(h.orchestrator);
    expect(h.deps.git).toBe(h.git);
  });

  it('passes time on the injected clock rather than in real seconds', async () => {
    h = await buildTestWorker();
    const before = h.clock.now().getTime();

    await h.deps.sleep(30_000);

    expect(h.sleeps).toEqual([30_000]);
    expect(h.clock.now().getTime() - before).toBe(30_000);
  });

  it('accepts environment overrides so a test can vary one setting', async () => {
    h = await buildTestWorker({ MODEL_MAX_TOKENS: '1000', COMMIT_CADENCE_WARN_AFTER: '2' });

    expect(h.config.modelMaxTokens).toBe(1000);
    expect(h.config.commitCadenceWarnAfter).toBe(2);
  });

  it('builds a dispatch carrying every field the orchestrator sends', async () => {
    h = await buildTestWorker();
    const dispatch = taskDispatch({ execution_attempt: 2, cost_spent_so_far_microusd: 4200 });

    expect(dispatch.plan_id).toBe(h.config.planId);
    expect(dispatch.execution_attempt).toBe(2);
    expect(dispatch.cost_spent_so_far_microusd).toBe(4200);
    expect(dispatch.limits).toEqual({ cost_microusd: 100_000, wall_clock_min: 30 });
  });
});
