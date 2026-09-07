import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDispatchedTask } from '../src/task.js';
import { buildTestWorker, taskDispatch, type TestWorker } from './helpers/agent.js';

/**
 * `task.ts`'s own contract, and nothing beneath it: acknowledge, run, report.
 * `task.ts` no longer knows how a task actually runs (ticket 09) — it hands
 * the dispatch and the abort signal to `deps.runner` and reports whatever
 * `TaskOutcome` comes back, which `test/runner.test.ts` already covers for
 * the report-mapping itself (done/failed, result, error, cost, tokens).
 *
 * Ticket 14: this file used to drive the whole host-owned loop through
 * `task.ts`'s front door with a scripted stand-in model transport (budget
 * exhaustion, the commit-cadence instrument, refusal, `no_terminal_call`,
 * transport failure, abort) — that was the host-owned loop's own behaviour,
 * not task.ts's, and it is gone. The equivalent behaviour for the one
 * surviving runner is `test/runner/agent-sdk.test.ts`'s own "silence is never
 * success" / "refusal" / "abort" / "wall clock" / "transport failure" suites.
 * The commit-cadence instrument has no Agent SDK equivalent at all — see the
 * ticket 14 completion report for why that is a real, not merely relocated,
 * loss of coverage. What is left here is what was always task.ts's own job.
 */

let h: TestWorker;

beforeEach(async () => {
  h = await buildTestWorker();
});

afterEach(async () => {
  await h.close();
});

async function run(overrides: Partial<ReturnType<typeof taskDispatch>> = {}, signal?: AbortSignal) {
  return runDispatchedTask(
    h.deps,
    taskDispatch(overrides),
    signal ?? new AbortController().signal,
  );
}

describe('acknowledgement', () => {
  it('reports running before it does anything else', async () => {
    h.runner.push({ state: 'done', costMicrousd: 10, tokensSpent: 10, result: { summary: 'did it' } });

    await run();

    // `dispatched -> running` is what clears the orchestrator's lease; a task
    // that ran first and acknowledged later could lose the lease mid-work.
    expect(h.orchestrator.reports[0]?.report).toEqual({ state: 'running' });
    expect(h.orchestrator.reports).toHaveLength(2);
  });

  it('still runs the task when the acknowledgement could not be delivered', async () => {
    h.orchestrator.failFirst = 1;
    h.runner.push({ state: 'done', costMicrousd: 10, tokensSpent: 10, result: { summary: 'did it' } });

    await run();

    // The lease will expire and the orchestrator will re-dispatch. Refusing to
    // work because one POST failed would guarantee the failure it fears.
    expect(h.runner.callCount).toBe(1);
  });
});
