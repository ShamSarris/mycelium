import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { looksLikeSecretKey } from '@mycelium/contracts';
import { runTask } from '../src/loop/run.js';
import type { ContentBlock, ModelResponse } from '../src/transport/transport.js';
import { buildTestWorker, taskDispatch, type TestWorker } from './helpers/agent.js';
import { FakeRegistry, usage } from './helpers/fakes.js';

/**
 * The host owns the loop and the conversation state (archive T16). Everything
 * here follows from that: the request is rebuilt from this side's own state
 * every turn, the provider is never asked to remember anything, and the loop
 * ends because a terminating tool was called rather than because the model
 * stopped talking.
 */

let h: TestWorker;
let tools: FakeRegistry;

beforeEach(async () => {
  h = await buildTestWorker();
  tools = new FakeRegistry();
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

function toolUse(id: string, name: string, input: Record<string, unknown> = {}): ContentBlock {
  return { type: 'tool_use', id, name, input };
}

function completes(id = 'tu-done'): ContentBlock {
  return toolUse(id, 'task_complete', { summary: 'did the thing' });
}

async function run(signal = new AbortController().signal) {
  // `runTask` now takes `Deps` plus the transport `HostLoopRunner` would
  // otherwise supply (ticket 09) — the direct call here reassembles that by
  // hand instead of going through the seam, so these tests keep driving the
  // loop itself rather than the runner wrapping it.
  return runTask({ ...h.deps, transport: h.transport }, taskDispatch(), tools, signal);
}

describe('a task that completes', () => {
  it('reports done with what the terminating tool said', async () => {
    tools.completeWith = { summary: 'added the endpoint', commitSha: 'abc123' };
    h.transport.push(turn([{ type: 'text', text: 'on it' }, completes()]));

    const outcome = await run();

    expect(outcome.state).toBe('done');
    expect(outcome.result).toEqual({ summary: 'added the endpoint', commit_sha: 'abc123' });
  });

  it('carries the task-wide token total, not this attempt is own', async () => {
    h.transport.push(turn([completes()], { usage: usage({ inputTokens: 300, outputTokens: 200 }) }));

    const outcome = await runTask(
      { ...h.deps, transport: h.transport },
      taskDispatch({ cost_spent_so_far_microusd: 1000, execution_attempt: 2 }),
      tools,
      new AbortController().signal,
    );

    // A retry that reported only its own spend would let the orchestrator
    // believe the task had used 500 tokens across two attempts.
    expect(outcome.tokensSpent).toBe(1500);
    expect(outcome.costMicrousd).toBe(1500);
  });

  it('threads tool results back and keeps going', async () => {
    tools.results.set('sandbox', { kind: 'result', content: 'tests passed', isError: false });
    h.transport.push(turn([toolUse('tu-1', 'sandbox', { cmd: ['npm', 'test'] })]));
    h.transport.push(turn([completes()]));

    const outcome = await run();

    expect(outcome.state).toBe('done');
    expect(tools.calls.map((call) => call.name)).toEqual(['sandbox', 'task_complete']);

    // Second request: the tool result came back as its own user turn.
    const second = h.transport.requests[1]!;
    const last = second.messages.at(-1)!;
    expect(last.role).toBe('user');
    expect(last.content).toEqual([
      { type: 'tool_result', toolUseId: 'tu-1', content: 'tests passed', isError: false },
    ]);
  });

  it('returns every parallel tool result in a single user message', async () => {
    tools.results.set('read_file', { kind: 'result', content: 'contents', isError: false });
    tools.results.set('sandbox', { kind: 'result', content: 'ok', isError: false });
    h.transport.push(
      turn([toolUse('tu-1', 'read_file', { path: 'a.ts' }), toolUse('tu-2', 'sandbox', {})]),
    );
    h.transport.push(turn([completes()]));

    await run();

    // Splitting these across two messages silently teaches the model to stop
    // calling in parallel.
    const second = h.transport.requests[1]!;
    const userTurns = second.messages.filter((message) => message.role === 'user');
    expect(userTurns).toHaveLength(2); // the task, then one message with both results
    expect(userTurns.at(-1)!.content).toHaveLength(2);
  });

  it('sends a failed tool back as a result, not as a dropped call', async () => {
    tools.results.set('sandbox', { kind: 'result', content: 'image_not_allowed', isError: true });
    h.transport.push(turn([toolUse('tu-1', 'sandbox', {})]));
    h.transport.push(turn([completes()]));

    await run();

    const last = h.transport.requests[1]!.messages.at(-1)!;
    expect(last.content).toEqual([
      { type: 'tool_result', toolUseId: 'tu-1', content: 'image_not_allowed', isError: true },
    ]);
  });
});

describe('canonical conversation state', () => {
  it('rebuilds the whole request from the host is own state every turn', async () => {
    tools.results.set('sandbox', { kind: 'result', content: 'ok', isError: false });
    h.transport.push(turn([toolUse('tu-1', 'sandbox', {})]));
    h.transport.push(turn([toolUse('tu-2', 'sandbox', {})]));
    h.transport.push(turn([completes()]));

    await run();

    const [first, second, third] = h.transport.requests;
    // Each request carries everything before it. A provider session is never
    // authoritative, so the transport is never asked to remember a turn.
    expect(first!.messages).toHaveLength(1);
    expect(second!.messages).toHaveLength(3);
    expect(third!.messages).toHaveLength(5);
  });

  it('keeps the system prompt and the tool list identical across turns', async () => {
    tools.results.set('sandbox', { kind: 'result', content: 'ok', isError: false });
    h.transport.push(turn([toolUse('tu-1', 'sandbox', {})]));
    h.transport.push(turn([completes()]));

    await run();

    // The stable prefix is what makes the cache breakpoint worth having.
    const [first, second] = h.transport.requests;
    expect(second!.system).toBe(first!.system);
    expect(second!.tools).toEqual(first!.tools);
  });

  it('opens with the task description and nothing else', async () => {
    h.transport.push(turn([completes()]));

    await run();

    const first = h.transport.requests[0]!;
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0]!.role).toBe('user');
    const text = first.messages[0]!.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    expect(text).toContain(taskDispatch().description);
    // No plan DAG, no sibling transcripts, no event stream (archive T13).
    expect(text).not.toContain('depends_on');
  });

  it('asks for the model and effort the configuration names', async () => {
    h.transport.push(turn([completes()]));

    await run();

    expect(h.transport.requests[0]!.model).toBe('claude-opus-5');
    expect(h.transport.requests[0]!.effort).toBe('high');
    expect(h.transport.requests[0]!.maxTokens).toBe(h.config.modelMaxTokens);
  });
});

describe('a task that ends badly', () => {
  it('fails when the terminating tool says so', async () => {
    tools.failWith = { errorClass: 'compile_error', detail: 'tsc found 3 errors' };
    h.transport.push(turn([toolUse('tu-1', 'task_failed', {})]));

    const outcome = await run();

    expect(outcome.state).toBe('failed');
    expect(outcome.error).toBe('compile_error: tsc found 3 errors');
  });

  it('nudges once when the model produces text and no tool call', async () => {
    h.transport.push(turn([{ type: 'text', text: 'I think I am done.' }]));
    h.transport.push(turn([completes()]));

    const outcome = await run();

    expect(outcome.state).toBe('done');
    // The nudge is a user turn telling it to call a terminating tool.
    const second = h.transport.requests[1]!;
    const last = second.messages.at(-1)!;
    expect(last.role).toBe('user');
    expect(JSON.stringify(last.content)).toContain('task_complete');
  });

  it('fails rather than nudging twice', async () => {
    h.transport.push(turn([{ type: 'text', text: 'done I think' }]));
    h.transport.push(turn([{ type: 'text', text: 'still done' }]));

    const outcome = await run();

    // Two nudges would be a loop; none would make silence indistinguishable
    // from success.
    expect(outcome.state).toBe('failed');
    expect(outcome.error).toContain('no_terminal_call');
    expect(h.transport.callCount).toBe(2);
  });

  it('fails without retrying when the transport throws', async () => {
    h.transport.push(new Error('connection reset'));

    const outcome = await run();

    expect(outcome.state).toBe('failed');
    expect(outcome.error).toContain('connection reset');
    // The orchestrator owns the failure policy. The agent never retries.
    expect(h.transport.callCount).toBe(1);
  });

  it('fails with the category when the model refuses', async () => {
    h.transport.push({
      content: [],
      stopReason: 'refusal',
      refusal: { category: 'cyber' },
      usage: usage(),
    });

    const outcome = await run();

    expect(outcome.state).toBe('failed');
    expect(outcome.error).toContain('refusal');
    expect(outcome.error).toContain('cyber');
  });

  it('fails explicitly when the model runs out of output room', async () => {
    h.transport.push(turn([{ type: 'text', text: 'half a th' }], { stopReason: 'max_tokens' }));

    const outcome = await run();

    expect(outcome.state).toBe('failed');
    expect(outcome.error).toContain('max_tokens');
  });
});

describe('events', () => {
  it('emits one agent.model_call per turn, carrying the cumulative total', async () => {
    h.transport.push(
      turn([toolUse('tu-1', 'sandbox', {})], { usage: usage({ inputTokens: 100, outputTokens: 100 }) }),
    );
    h.transport.push(turn([completes()], { usage: usage({ inputTokens: 100, outputTokens: 100 }) }));
    tools.results.set('sandbox', { kind: 'result', content: 'ok', isError: false });

    await runTask(
      { ...h.deps, transport: h.transport },
      taskDispatch({ cost_spent_so_far_microusd: 1000 }),
      tools,
      new AbortController().signal,
    );

    const calls = h.broker.ofType('agent.model_call');
    expect(calls).toHaveLength(2);
    // Cumulative, not a delta: a dropped event on a bounded spool must not
    // lose spend, and a retry must not reset the running total.
    expect(calls[0]?.payload?.tokens_total).toBe(1200);
    expect(calls[1]?.payload?.tokens_total).toBe(1400);
    // Cost mirrors the token total for now: domain/budget.ts is not converted
    // (ticket 07 decision), so the same cumulative number is reported under
    // both names until tickets 09-11 install real cost tracking.
    expect(calls[0]?.payload?.cost_total_microusd).toBe(1200);
    expect(calls[1]?.payload?.cost_total_microusd).toBe(1400);
  });

  it('emits cache_write_tokens, which counted toward the budget but was never reported', async () => {
    h.transport.push(
      turn([completes()], { usage: usage({ cacheWriteTokens: 40 }) }),
    );

    await run();

    const call = h.broker.ofType('agent.model_call')[0];
    expect(call?.payload?.cache_write_tokens).toBe(40);
  });

  it('never uses an agent.model_call payload key that looksLikeSecretKey would flag', async () => {
    h.transport.push(
      turn([completes()], {
        usage: usage({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5 }),
      }),
    );

    await run();

    const call = h.broker.ofType('agent.model_call')[0];
    const payload = call?.payload as Record<string, unknown>;
    for (const key of Object.keys(payload)) {
      expect(looksLikeSecretKey(key)).toBe(false);
    }
  });

  it('never emits task.state_changed - the orchestrator records that itself', async () => {
    h.transport.push(turn([completes()]));

    await run();

    expect(h.broker.events.map((event) => event.type)).not.toContain('task.state_changed');
  });

  it('tags every event with the task it belongs to', async () => {
    h.transport.push(turn([completes()]));

    await run();

    expect(h.broker.events.every((event) => event.taskId === taskDispatch().task_id)).toBe(true);
  });
});
