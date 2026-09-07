import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TaskOutcome } from '../src/runner/runner.js';
import { runDispatchedTask } from '../src/task.js';
import { buildTestWorker, taskDispatch, type TestWorker } from './helpers/agent.js';
import { FakeTaskRunner } from './helpers/fakes.js';

/**
 * `task.ts` no longer knows how a task actually runs — it hands the dispatch
 * and the abort signal to `deps.runner` and reports whatever `TaskOutcome`
 * comes back. This is the seam ticket 11's Agent SDK runner sits behind
 * instead of the host-owned loop. `test/task.test.ts` and `test/loop.test.ts`
 * already cover the host loop's own behaviour end to end; this file only has
 * to prove the seam itself is wired.
 */

let h: TestWorker;
let runner: FakeTaskRunner;

beforeEach(async () => {
  h = await buildTestWorker();
  runner = new FakeTaskRunner();
  h.deps.runner = runner;
});

afterEach(async () => {
  await h.close();
});

function outcome(overrides: Partial<TaskOutcome> = {}): TaskOutcome {
  return {
    state: 'done',
    costMicrousd: 1234,
    tokensSpent: 1234,
    result: { summary: 'did the thing' },
    ...overrides,
  };
}

describe('the runner seam', () => {
  it('calls deps.runner.run with the dispatch and the abort signal', async () => {
    runner.push(outcome());
    const controller = new AbortController();
    const dispatch = taskDispatch();

    await runDispatchedTask(h.deps, dispatch, controller.signal);

    expect(runner.callCount).toBe(1);
    expect(runner.calls[0]?.dispatch).toEqual(dispatch);
    expect(runner.calls[0]?.signal).toBe(controller.signal);
  });

  it('reports a done outcome exactly as the runner returned it', async () => {
    runner.push(
      outcome({
        state: 'done',
        costMicrousd: 500,
        tokensSpent: 500,
        result: { summary: 'added the endpoint' },
      }),
    );

    await runDispatchedTask(h.deps, taskDispatch(), new AbortController().signal);

    expect(h.orchestrator.last).toMatchObject({
      state: 'done',
      cost_spent_microusd: 500,
      tokens_spent: 500,
      result: { summary: 'added the endpoint' },
    });
  });

  it('reports a failed outcome with the error the runner gave', async () => {
    runner.push(
      outcome({ state: 'failed', result: undefined, error: 'transport_error: boom' }),
    );

    await runDispatchedTask(h.deps, taskDispatch(), new AbortController().signal);

    expect(h.orchestrator.last).toMatchObject({ state: 'failed', error: 'transport_error: boom' });
  });
});
