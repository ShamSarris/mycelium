import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDispatchedTask } from '../src/task.js';
import type { ContentBlock, ModelResponse } from '../src/transport/transport.js';
import { buildTestWorker, taskDispatch, type TestWorker } from './helpers/agent.js';
import { usage } from './helpers/fakes.js';

/**
 * Everything between a dispatch arriving and a status report going out: the
 * acknowledgement that clears the lease, the loop, the limits, and the mapping
 * from how a task ended to what the orchestrator is told.
 *
 * The mapping is the part worth pinning down. Each row of ticket 0004 section
 * 9.4 is one test, because the difference between "failed with a reason" and
 * "went quiet" is exactly what someone debugging this in six weeks will need.
 */

let h: TestWorker;

beforeEach(async () => {
  h = await buildTestWorker();
});

afterEach(async () => {
  await h.close();
});

function turn(content: ContentBlock[], overrides: Partial<ModelResponse> = {}): ModelResponse {
  const hasToolUse = content.some((block) => block.type === 'tool_use');
  return {
    content,
    stopReason: hasToolUse ? 'tool_use' : 'end_turn',
    usage: usage(),
    ...overrides,
  };
}

function toolUse(name: string, input: Record<string, unknown> = {}, id = 'tu-1'): ContentBlock {
  return { type: 'tool_use', id, name, input };
}

function completes(summary = 'did the thing'): ContentBlock {
  return toolUse('task_complete', { summary }, 'tu-done');
}

async function run(overrides: Partial<ReturnType<typeof taskDispatch>> = {}, signal?: AbortSignal) {
  return runDispatchedTask(
    h.deps,
    taskDispatch(overrides),
    signal ?? new AbortController().signal,
  );
}

describe('acknowledgement', () => {
  it('reports running before it does anything else', async () => {
    h.transport.push(turn([completes()]));

    await run();

    // `dispatched -> running` is what clears the orchestrator's lease; a task
    // that ran first and acknowledged later could lose the lease mid-work.
    expect(h.orchestrator.reports[0]?.report).toEqual({ state: 'running' });
    expect(h.orchestrator.reports).toHaveLength(2);
  });

  it('still runs the task when the acknowledgement could not be delivered', async () => {
    h.orchestrator.failFirst = 1;
    h.transport.push(turn([completes()]));

    await run();

    // The lease will expire and the orchestrator will re-dispatch. Refusing to
    // work because one POST failed would guarantee the failure it fears.
    expect(h.transport.callCount).toBe(1);
  });
});

describe('the report table', () => {
  it('reports done with a structured result', async () => {
    h.transport.push(turn([completes('added the endpoint')]));

    await run();

    expect(h.orchestrator.last).toMatchObject({
      state: 'done',
      result: { summary: 'added the endpoint' },
    });
    expect(h.orchestrator.last?.tokens_spent).toBe(150);
    expect(h.orchestrator.last?.cost_spent_microusd).toBe(150);
  });

  it('reports failed with the error class the model gave', async () => {
    h.transport.push(
      turn([toolUse('task_failed', { error_class: 'compile_error', detail: 'tsc found 3' })]),
    );

    await run();

    expect(h.orchestrator.last).toMatchObject({
      state: 'failed',
      error: 'compile_error: tsc found 3',
    });
  });

  it('reports failed with limit_exceeded when the token ceiling is reached', async () => {
    // The reservation alone is bigger than the ceiling, so the very first call
    // is refused before it is sent.
    await run({ limits: { cost_microusd: 100, wall_clock_min: 30 } });

    expect(h.transport.callCount).toBe(0);
    expect(h.orchestrator.last?.state).toBe('failed');
    expect(h.orchestrator.last?.error).toContain('limit_exceeded');

    const limits = h.broker.ofType('limit.exceeded');
    expect(limits).toHaveLength(1);
    expect(limits[0]?.payload).toMatchObject({ limit: 'tokens' });
  });

  it('reports failed when the wall clock runs out', async () => {
    h.transport.onSend = () => {
      // One turn's worth of work takes longer than the whole allowance.
      h.clock.advance(31 * 60_000);
    };
    h.transport.push(turn([toolUse('list_files')]));

    await run({ limits: { cost_microusd: 1_000_000, wall_clock_min: 30 } });

    expect(h.orchestrator.last?.error).toContain('limit_exceeded');
    expect(h.broker.ofType('limit.exceeded')[0]?.payload).toMatchObject({
      limit: 'wall_clock_min',
    });
  });

  it('reports failed with the refusal category', async () => {
    h.transport.push({
      content: [],
      stopReason: 'refusal',
      refusal: { category: 'cyber' },
      usage: usage(),
    });

    await run();

    expect(h.orchestrator.last?.error).toContain('refusal');
    expect(h.orchestrator.last?.error).toContain('cyber');
  });

  it('reports failed when the model never calls a terminating tool', async () => {
    h.transport.push(turn([{ type: 'text', text: 'done' }]));
    h.transport.push(turn([{ type: 'text', text: 'still done' }]));

    await run();

    expect(h.orchestrator.last?.error).toContain('no_terminal_call');
  });

  it('reports failed when the transport gives up', async () => {
    h.transport.push(new Error('connection reset'));

    await run();

    expect(h.orchestrator.last?.error).toContain('transport_error');
  });

  it('always reports the task-wide token total, whatever the outcome', async () => {
    h.transport.push(new Error('connection reset'));

    await run({ cost_spent_so_far_microusd: 900 });

    // Even a failed attempt has to hand back the running total, or the next
    // attempt would start from a number that is too low.
    expect(h.orchestrator.last?.tokens_spent).toBe(900);
    expect(h.orchestrator.last?.cost_spent_microusd).toBe(900);
  });
});

describe('the commit-cadence instrument', () => {
  it('warns once when tool calls pile up without a commit, and does not block', async () => {
    h = await buildTestWorker({ COMMIT_CADENCE_WARN_AFTER: '2' });
    for (let i = 0; i < 4; i += 1) {
      h.transport.push(turn([toolUse('list_files', {}, `tu-${i}`)]));
    }
    h.transport.push(turn([completes()]));

    await run();

    const warnings = h.broker
      .ofType('limit.exceeded')
      .filter((event) => event.payload?.limit === 'commit_cadence');
    // The instrument, not the enforcement: one warning, and every tool call
    // still ran. The threshold is a guess until there is data behind it.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.severity).toBe('warn');
    expect(h.orchestrator.last?.state).toBe('done');
  });

  it('resets the count on a commit', async () => {
    h = await buildTestWorker({ COMMIT_CADENCE_WARN_AFTER: '3' });
    h.transport.push(turn([toolUse('list_files', {}, 'tu-1')]));
    h.transport.push(turn([toolUse('list_files', {}, 'tu-2')]));
    h.transport.push(turn([toolUse('git', { action: 'commit', message: 'checkpoint' }, 'tu-3')]));
    h.transport.push(turn([toolUse('list_files', {}, 'tu-4')]));
    h.transport.push(turn([toolUse('list_files', {}, 'tu-5')]));
    h.transport.push(turn([completes()]));

    await run();

    expect(
      h.broker.ofType('limit.exceeded').filter((e) => e.payload?.limit === 'commit_cadence'),
    ).toHaveLength(0);
  });

  it('says nothing at all when the model commits as it goes', async () => {
    h = await buildTestWorker({ COMMIT_CADENCE_WARN_AFTER: '2' });
    h.transport.push(turn([toolUse('git', { action: 'commit', message: 'checkpoint' })]));
    h.transport.push(turn([completes()]));

    await run();

    expect(h.broker.ofType('limit.exceeded')).toHaveLength(0);
  });
});

describe('abort', () => {
  it('stops the loop and reports the abort', async () => {
    const controller = new AbortController();
    controller.abort();

    await run({}, controller.signal);

    expect(h.transport.callCount).toBe(0);
    expect(h.orchestrator.last?.state).toBe('failed');
    expect(h.orchestrator.last?.error).toContain('aborted');
  });
});
