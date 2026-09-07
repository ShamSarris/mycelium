import path from 'node:path';
import { looksLikeSecretKey } from '@mycelium/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../src/broker.js';
import { buildTestWorker, taskDispatch, type TestWorker } from '../helpers/agent.js';

/**
 * `agent-sdk.ts` is the one file this ticket set allows to import
 * `@anthropic-ai/claude-agent-sdk` — so its `query()` is mocked here rather
 * than run for real (a real run needs a subprocess, an API key, and real
 * money; see `test/integration/live-model.test.ts` §6.5 for the gated live
 * case). `runner/tools.ts`'s `buildMyceliumServer` is also replaced: its own
 * behaviour (the MCP protocol, the terminal-tool signalling box) is already
 * proven end to end by `test/tools.test.ts` (ticket 10); this file only needs
 * a way to reach into the box `agent-sdk.ts` creates, to simulate the model
 * having called `task_complete` / `task_failed` without driving the real MCP
 * wire protocol a second time.
 */

const queryMock = vi.fn();

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  return { ...actual, query: (args: unknown) => queryMock(args) };
});

let capturedOutcomeBox: { outcome: unknown } | null = null;
/**
 * The commit-cadence box the runner hands the MCP `git` tool. Captured for
 * the same reason as the outcome box above: the real `git` tool is not driven
 * here, so a test that wants to say "the model committed" writes the commit
 * into this box directly, exactly as `runner/tools.ts`'s handler would.
 */
let capturedCommitBox: { commits: number } | null = null;

vi.mock('../../src/runner/tools.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/runner/tools.js')>();
  return {
    ...actual,
    buildMyceliumServer: vi.fn(
      (
        _deps: unknown,
        outcomeBox: { outcome: unknown },
        _taskId: string,
        commitBox: { commits: number },
      ) => {
        capturedOutcomeBox = outcomeBox;
        capturedCommitBox = commitBox;
        return { __fakeMcpServer: true };
      },
    ),
  };
});

const { AgentSdkRunner } = await import('../../src/runner/agent-sdk.js');
const { SUBAGENT_ROSTER } = await import('../../src/runner/subagents.js');

let h: TestWorker;

beforeEach(async () => {
  h = await buildTestWorker();
  queryMock.mockReset();
  capturedOutcomeBox = null;
  capturedCommitBox = null;
});

afterEach(async () => {
  await h.close();
});

/** A hand-written message, shaped like the real SDK's, structurally. */
function assistantMessage(
  overrides: {
    usage?: { input_tokens: number; output_tokens: number };
    stop_reason?: string | null;
    stop_details?: { category: string | null } | null;
    content?: Array<{ type: string; id?: string; name?: string }>;
  } = {},
) {
  return {
    type: 'assistant',
    message: {
      model: 'claude-sonnet-5',
      stop_reason: overrides.stop_reason ?? 'tool_use',
      stop_details: overrides.stop_details ?? null,
      usage: overrides.usage ?? { input_tokens: 10, output_tokens: 5 },
      content: overrides.content ?? [],
    },
  };
}

function resultMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    modelUsage: {
      'claude-sonnet-5': {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 0.02,
      },
    },
    ...overrides,
  };
}

/**
 * Deferred so a test can control exactly when a "step" (yield a message, or
 * pause until released) proceeds — needed to abort or time out mid-run
 * rather than only after the whole script has played out.
 */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

type Step = { message: unknown } | { gate: Promise<void> } | { hang: true };

/** Builds a fake `query()` implementation from a script of steps. */
function scriptedQuery(steps: Step[]) {
  return async function* () {
    for (const step of steps) {
      if ('gate' in step) {
        await step.gate;
        continue;
      }
      if ('hang' in step) {
        // Simulates a subprocess that never exits after abort — the exact
        // shape 01-findings.md Q5 reproduced. The runner must not await this.
        await new Promise(() => {});
        return;
      }
      yield step.message;
    }
  };
}

describe('the isolation settings', () => {
  it('passes tools, allowedTools, and every isolation setting the plan requires', async () => {
    queryMock.mockImplementation(() =>
      scriptedQuery([{ message: resultMessage() }])(),
    );

    const runner = new AgentSdkRunner(h.deps);
    await runner.run(taskDispatch(), new AbortController().signal);

    expect(queryMock).toHaveBeenCalledTimes(1);
    const options = (queryMock.mock.calls[0]?.[0] as { options: Record<string, unknown> }).options;

    expect(options.tools).toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Agent']);
    expect(options.tools).not.toContain('Bash');
    expect(options.allowedTools).toEqual(
      expect.arrayContaining([
        'Read',
        'Write',
        'Edit',
        'Glob',
        'Grep',
        'Agent',
        'mcp__mycelium__sandbox',
        'mcp__mycelium__git',
        'mcp__mycelium__task_complete',
        'mcp__mycelium__task_failed',
      ]),
    );
    expect(options.settingSources).toEqual([]);
    expect(options.persistSession).toBe(false);
    expect(options.cwd).toBe(h.config.workdir);

    // Ticket 12: the PreToolUse containment hook is registered, not just
    // implemented — a real regression this test would have caught for
    // ticket 11's own isolation settings would equally apply here.
    const hooks = options.hooks as { PreToolUse?: Array<{ hooks: unknown[] }> };
    expect(hooks.PreToolUse).toBeDefined();
    // The containment hook is the first entry, and stays the first entry:
    // the subagent-attribution hook registered beside it is bookkeeping and
    // must never be mistaken for the one that can deny.
    expect(hooks.PreToolUse?.[0]?.hooks).toHaveLength(1);

    const env = options.env as Record<string, string>;
    expect(env.CLAUDE_CONFIG_DIR).toBe(h.config.claudeConfigDir);
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    expect(env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false');
  });

  it('replaces the whole system prompt rather than appending to a preset', async () => {
    queryMock.mockImplementation(() => scriptedQuery([{ message: resultMessage() }])());

    const runner = new AgentSdkRunner(h.deps);
    await runner.run(taskDispatch(), new AbortController().signal);

    const options = (queryMock.mock.calls[0]?.[0] as { options: Record<string, unknown> }).options;
    expect(options.systemPrompt).toMatchObject({ type: 'custom' });
    expect((options.systemPrompt as { prompt: string }).prompt).toContain(h.config.projectName);
  });

  it('applies the configured reasoning effort to the main agent', async () => {
    queryMock.mockImplementation(() => scriptedQuery([{ message: resultMessage() }])());

    const runner = new AgentSdkRunner(h.deps);
    await runner.run(taskDispatch(), new AbortController().signal);

    const options = (queryMock.mock.calls[0]?.[0] as { options: Record<string, unknown> }).options;
    // MODEL_EFFORT is loaded and validated by `config.ts` and defaults to
    // 'high'. Without this line the SDK silently applies its own default
    // instead, and the operator's setting does nothing at all.
    expect(options.effort).toBe(h.config.modelEffort);
  });

  it('derives maxBudgetUsd from the dispatch cost ceiling', async () => {
    queryMock.mockImplementation(() => scriptedQuery([{ message: resultMessage() }])());

    const runner = new AgentSdkRunner(h.deps);
    await runner.run(taskDispatch({ limits: { cost_microusd: 2_500_000, wall_clock_min: 30 } }), new AbortController().signal);

    const options = (queryMock.mock.calls[0]?.[0] as { options: Record<string, unknown> }).options;
    expect(options.maxBudgetUsd).toBe(2.5);
  });
});

describe('subagents and concurrency (ticket 13)', () => {
  it('defines a minimal v1 roster whose tools are each a subset of the parent-s own tools', async () => {
    queryMock.mockImplementation(() => scriptedQuery([{ message: resultMessage() }])());

    const runner = new AgentSdkRunner(h.deps);
    await runner.run(taskDispatch(), new AbortController().signal);

    const options = (queryMock.mock.calls[0]?.[0] as { options: Record<string, unknown> }).options;
    const parentTools = options.tools as string[];
    const agents = options.agents as Record<string, { tools?: string[]; description: string }>;

    expect(Object.keys(agents).length).toBeGreaterThan(0);
    for (const [name, definition] of Object.entries(agents)) {
      expect(definition.description).toBeTruthy();
      for (const tool of definition.tools ?? []) {
        expect(parentTools, `${name}'s tool "${tool}" must be in the parent's own tools`).toContain(
          tool,
        );
      }
    }
  });

  it('gives the v1 explorer subagent only read-only tools — no Write or Edit', async () => {
    queryMock.mockImplementation(() => scriptedQuery([{ message: resultMessage() }])());

    const runner = new AgentSdkRunner(h.deps);
    await runner.run(taskDispatch(), new AbortController().signal);

    const options = (queryMock.mock.calls[0]?.[0] as { options: Record<string, unknown> }).options;
    const agents = options.agents as Record<string, { tools?: string[] }>;
    const explorer = agents.explorer;
    if (explorer === undefined) throw new Error('expected an "explorer" subagent to be defined');

    expect(explorer.tools).toEqual(expect.arrayContaining(['Read', 'Glob', 'Grep']));
    expect(explorer.tools).not.toContain('Write');
    expect(explorer.tools).not.toContain('Edit');
    expect(explorer.tools).not.toContain('Agent');
  });

  it('enables the Agent tool so subagents can actually be spawned', async () => {
    queryMock.mockImplementation(() => scriptedQuery([{ message: resultMessage() }])());

    const runner = new AgentSdkRunner(h.deps);
    await runner.run(taskDispatch(), new AbortController().signal);

    const options = (queryMock.mock.calls[0]?.[0] as { options: Record<string, unknown> }).options;
    expect(options.tools).toContain('Agent');
    expect(options.allowedTools).toContain('Agent');
  });

  it('sets CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH to 1 — no nested subagents in v1', async () => {
    queryMock.mockImplementation(() => scriptedQuery([{ message: resultMessage() }])());

    const runner = new AgentSdkRunner(h.deps);
    await runner.run(taskDispatch(), new AbortController().signal);

    const options = (queryMock.mock.calls[0]?.[0] as { options: Record<string, unknown> }).options;
    const env = options.env as Record<string, string>;
    expect(env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH).toBe('1');
  });

  it('derives CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS from config, not the plan', async () => {
    queryMock.mockImplementation(() => scriptedQuery([{ message: resultMessage() }])());

    const runner = new AgentSdkRunner(h.deps);
    await runner.run(taskDispatch(), new AbortController().signal);

    const options = (queryMock.mock.calls[0]?.[0] as { options: Record<string, unknown> }).options;
    const env = options.env as Record<string, string>;
    expect(env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS).toBe(String(h.config.maxConcurrentSubagents));
  });

  it('denies an out-of-workdir Read through the session-wide PreToolUse hooks, whether the caller is the main agent or a subagent (AgentDefinition carries no hooks field of its own)', async () => {
    queryMock.mockImplementation(() => scriptedQuery([{ message: resultMessage() }])());

    const runner = new AgentSdkRunner(h.deps);
    const dispatch = taskDispatch();
    await runner.run(dispatch, new AbortController().signal);

    const options = (queryMock.mock.calls[0]?.[0] as { options: Record<string, unknown> }).options;

    // One hook set is registered for the whole session — no per-agent
    // override exists in AgentDefinition — so whatever a subagent's own
    // Read/Glob/Grep call looks like on the wire, it runs through these.
    // Every registered hook is driven rather than just the first: what
    // matters is that the set denies, not which member of it does, and
    // asserting a count would break the next time one is added.
    const hooks = options.hooks as { PreToolUse: Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }> };
    const registered = hooks.PreToolUse.flatMap((entry) => entry.hooks);
    expect(registered.length).toBeGreaterThan(0);

    const decisions: string[] = [];
    for (const hook of registered) {
      const result = (await hook({
        tool_name: 'Read',
        tool_input: { file_path: '/etc/passwd' },
        tool_use_id: 'toolu_1',
      })) as { hookSpecificOutput?: { permissionDecision?: string } };
      const decision = result.hookSpecificOutput?.permissionDecision;
      if (decision !== undefined) decisions.push(decision);
    }

    // Exactly one: a second hook that also denied would mean the bookkeeping
    // hook had grown an opinion it must never have.
    expect(decisions).toEqual(['deny']);
    const denials = h.broker.ofType('agent.tool_call');
    expect(denials).toContainEqual(
      expect.objectContaining({
        taskId: dispatch.task_id,
        payload: expect.objectContaining({ tool: 'Read', is_error: true }),
      }),
    );
  });

  it('does not deny the Agent tool call itself — spawning a subagent is not a file operation', async () => {
    queryMock.mockImplementation(() => scriptedQuery([{ message: resultMessage() }])());

    const runner = new AgentSdkRunner(h.deps);
    await runner.run(taskDispatch(), new AbortController().signal);

    const options = (queryMock.mock.calls[0]?.[0] as { options: Record<string, unknown> }).options;
    const hooks = options.hooks as { PreToolUse: Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }> };
    const hook = hooks.PreToolUse[0]?.hooks[0];
    if (hook === undefined) throw new Error('PreToolUse hook was not registered');

    const result = (await hook({
      tool_name: 'Agent',
      tool_input: { description: 'look around', prompt: 'find the auth module', subagent_type: 'explorer' },
    })) as { hookSpecificOutput?: unknown };

    expect(result.hookSpecificOutput).toBeUndefined();
  });
});

describe('spend attribution across multiple models (ticket 13 §6.4)', () => {
  it('sums modelUsage across every model in the tree, not just one', async () => {
    queryMock.mockImplementation(() =>
      scriptedQuery([
        {
          message: resultMessage({
            modelUsage: {
              'claude-sonnet-5': {
                inputTokens: 100,
                outputTokens: 50,
                cacheReadInputTokens: 0,
                cacheCreationInputTokens: 0,
                costUSD: 0.02,
              },
              // The subagent's own model call — Q6 (01-findings.md): plain
              // `usage` excludes this entirely; `modelUsage` is what a
              // subagent tree's real spend has to be read from.
              'claude-haiku-4-5-20251001': {
                inputTokens: 30,
                outputTokens: 15,
                cacheReadInputTokens: 0,
                cacheCreationInputTokens: 0,
                costUSD: 0.005,
              },
            },
          }),
        },
      ])(),
    );

    const runner = new AgentSdkRunner(h.deps);
    const runPromise = runner.run(taskDispatch(), new AbortController().signal);
    capturedOutcomeBox!.outcome = { kind: 'complete', summary: 'done' };
    const outcome = await runPromise;

    // (0.02 + 0.005) * 1_000_000 = 25_000 microusd — both models counted.
    expect(outcome.costMicrousd).toBe(25_000);
  });
});

describe('containment hook wiring (ticket 12)', () => {
  it('registers a PreToolUse hook that denies an out-of-workdir Read and emits agent.tool_call', async () => {
    queryMock.mockImplementation(() => scriptedQuery([{ message: resultMessage() }])());

    const runner = new AgentSdkRunner(h.deps);
    const dispatch = taskDispatch();
    await runner.run(dispatch, new AbortController().signal);

    const options = (queryMock.mock.calls[0]?.[0] as { options: Record<string, unknown> }).options;
    const hooks = options.hooks as { PreToolUse: Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }> };
    const hook = hooks.PreToolUse[0]?.hooks[0];
    if (hook === undefined) throw new Error('PreToolUse hook was not registered');

    const result = (await hook({
      tool_name: 'Read',
      tool_input: { file_path: '/etc/passwd' },
    })) as { hookSpecificOutput?: { permissionDecision?: string } };

    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');

    const denials = h.broker.ofType('agent.tool_call');
    expect(denials).toContainEqual(
      expect.objectContaining({
        taskId: dispatch.task_id,
        payload: expect.objectContaining({ tool: 'Read', is_error: true }),
      }),
    );
  });

  it('allows a Read inside the workdir through, with no denial event', async () => {
    queryMock.mockImplementation(() => scriptedQuery([{ message: resultMessage() }])());

    const runner = new AgentSdkRunner(h.deps);
    await runner.run(taskDispatch(), new AbortController().signal);

    const options = (queryMock.mock.calls[0]?.[0] as { options: Record<string, unknown> }).options;
    const hooks = options.hooks as { PreToolUse: Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }> };
    const hook = hooks.PreToolUse[0]?.hooks[0];
    if (hook === undefined) throw new Error('PreToolUse hook was not registered');

    const before = h.broker.ofType('agent.tool_call').length;
    const result = (await hook({
      tool_name: 'Read',
      tool_input: { file_path: path.join(h.config.workdir, 'README.md') },
    })) as { hookSpecificOutput?: unknown };

    expect(result.hookSpecificOutput).toBeUndefined();
    expect(h.broker.ofType('agent.tool_call').length).toBe(before);
  });
});

describe('completion', () => {
  it('reports done and real cost from modelUsage when task_complete was called', async () => {
    queryMock.mockImplementation(() =>
      scriptedQuery([
        {
          message: {
            type: 'user',
            message: { content: 'tool call happens off-script' },
          },
        },
        { message: resultMessage() },
      ])(),
    );

    const runner = new AgentSdkRunner(h.deps);
    const runPromise = runner.run(taskDispatch(), new AbortController().signal);

    // Simulate the model having called task_complete via the real MCP
    // server, whose behaviour test/tools.test.ts already covers.
    capturedOutcomeBox!.outcome = { kind: 'complete', summary: 'added the endpoint' };

    const outcome = await runPromise;

    expect(outcome.state).toBe('done');
    expect(outcome.result).toEqual({ summary: 'added the endpoint' });
    // costUSD 0.02 * 1_000_000 = 20_000 microusd.
    expect(outcome.costMicrousd).toBe(20_000);
  });

  it('reports failed with the error class when task_failed was called', async () => {
    queryMock.mockImplementation(() => scriptedQuery([{ message: resultMessage() }])());

    const runner = new AgentSdkRunner(h.deps);
    const runPromise = runner.run(taskDispatch(), new AbortController().signal);
    capturedOutcomeBox!.outcome = { kind: 'failed', errorClass: 'compile_error', detail: 'tsc found 3' };

    const outcome = await runPromise;

    expect(outcome.state).toBe('failed');
    expect(outcome.error).toBe('compile_error: tsc found 3');
  });

  it('seeds cost from prior execution attempts', async () => {
    queryMock.mockImplementation(() => scriptedQuery([{ message: resultMessage() }])());

    const runner = new AgentSdkRunner(h.deps);
    const runPromise = runner.run(
      taskDispatch({ cost_spent_so_far_microusd: 1_000, execution_attempt: 2 }),
      new AbortController().signal,
    );
    capturedOutcomeBox!.outcome = { kind: 'complete', summary: 'done' };

    const outcome = await runPromise;
    expect(outcome.costMicrousd).toBe(21_000);
  });
});

describe('silence is never success', () => {
  it('fails with no_terminal_call when the run ends without a terminal tool call', async () => {
    queryMock.mockImplementation(() => scriptedQuery([{ message: resultMessage() }])());

    const runner = new AgentSdkRunner(h.deps);
    const outcome = await runner.run(taskDispatch(), new AbortController().signal);

    expect(outcome.state).toBe('failed');
    expect(outcome.error).toContain('no_terminal_call');
  });
});

describe('refusal', () => {
  it('fails visibly with the category rather than letting a fallback retry mask it', async () => {
    queryMock.mockImplementation(() =>
      scriptedQuery([
        { message: assistantMessage({ stop_reason: 'refusal', stop_details: { category: 'cyber' } }) },
      ])(),
    );

    const runner = new AgentSdkRunner(h.deps);
    const outcome = await runner.run(taskDispatch(), new AbortController().signal);

    expect(outcome.state).toBe('failed');
    expect(outcome.error).toContain('refusal');
    expect(outcome.error).toContain('cyber');
  });
});

describe('abort', () => {
  it('emits error{stage: aborted} and fails, without waiting for the subprocess to exit', async () => {
    const reached = deferred<void>();
    queryMock.mockImplementation(() =>
      scriptedQuery([
        {
          message: (() => {
            void reached.resolve();
            return assistantMessage();
          })(),
        },
        { hang: true },
      ])(),
    );

    const runner = new AgentSdkRunner(h.deps);
    const controller = new AbortController();
    const runPromise = runner.run(taskDispatch(), controller.signal);

    await reached.promise;
    controller.abort('operator cancelled');

    const outcome = await runPromise;

    expect(outcome.state).toBe('failed');
    expect(outcome.error).toBe('aborted: operator cancelled');

    const errors = h.broker.ofType('error');
    expect(errors).toContainEqual(
      expect.objectContaining({
        severity: 'warn',
        payload: expect.objectContaining({ stage: 'aborted', reason: 'operator cancelled' }),
      }),
    );
  });

  it('fails immediately when the signal is already aborted before the run starts', async () => {
    queryMock.mockImplementation(() => scriptedQuery([{ hang: true }])());

    const runner = new AgentSdkRunner(h.deps);
    const controller = new AbortController();
    controller.abort('shutting down');

    const outcome = await runner.run(taskDispatch(), controller.signal);

    expect(outcome.state).toBe('failed');
    expect(outcome.error).toBe('aborted: shutting down');
  });
});

describe('wall clock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fails with limit_exceeded naming the wall clock, without waiting for the subprocess', async () => {
    queryMock.mockImplementation(() => scriptedQuery([{ hang: true }])());

    const runner = new AgentSdkRunner(h.deps);
    const runPromise = runner.run(
      taskDispatch({ limits: { cost_microusd: 1_000_000, wall_clock_min: 30 } }),
      new AbortController().signal,
    );

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    const outcome = await runPromise;

    expect(outcome.state).toBe('failed');
    expect(outcome.error).toContain('limit_exceeded');
    expect(outcome.error).toContain('wall clock');

    const limits = h.broker.ofType('limit.exceeded');
    expect(limits).toContainEqual(
      expect.objectContaining({ payload: expect.objectContaining({ limit: 'wall_clock_min' }) }),
    );
  });
});

describe('transport failure', () => {
  it('fails with transport_error when query() itself throws, without retrying', async () => {
    queryMock.mockImplementation(() =>
      (async function* () {
        throw new Error('ENOENT: claude binary not found');
        // eslint-disable-next-line no-unreachable
        yield undefined;
      })(),
    );

    const runner = new AgentSdkRunner(h.deps);
    const outcome = await runner.run(taskDispatch(), new AbortController().signal);

    expect(outcome.state).toBe('failed');
    expect(outcome.error).toContain('transport_error');
    expect(outcome.error).toContain('claude binary not found');
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});

describe('events', () => {
  it('forwards mapped events to the broker with the task id attached', async () => {
    queryMock.mockImplementation(() =>
      scriptedQuery([{ message: assistantMessage() }, { message: resultMessage() }])(),
    );

    const runner = new AgentSdkRunner(h.deps);
    const dispatch = taskDispatch();
    const runPromise = runner.run(dispatch, new AbortController().signal);
    capturedOutcomeBox!.outcome = { kind: 'complete', summary: 'done' };
    await runPromise;

    const modelCalls = h.broker.ofType('agent.model_call');
    expect(modelCalls).toHaveLength(1);
    expect(modelCalls[0]?.taskId).toBe(dispatch.task_id);
  });

  it('never emits an agent.model_call payload key that looksLikeSecretKey would flag', async () => {
    queryMock.mockImplementation(() =>
      scriptedQuery([{ message: assistantMessage() }, { message: resultMessage() }])(),
    );

    const runner = new AgentSdkRunner(h.deps);
    const runPromise = runner.run(taskDispatch(), new AbortController().signal);
    capturedOutcomeBox!.outcome = { kind: 'complete', summary: 'done' };
    await runPromise;

    const events: AgentEvent[] = h.broker.ofType('agent.model_call');
    for (const event of events) {
      for (const key of Object.keys(event.payload ?? {})) {
        expect(looksLikeSecretKey(key)).toBe(false);
      }
    }
  });
});

/**
 * A `user` message carrying tool results — how the SDK reports what came back
 * from a tool call. `n` results in one message is the parallel-tool-call case.
 */
function toolResultMessage(count = 1) {
  return {
    type: 'user',
    message: {
      content: Array.from({ length: count }, (_unused, index) => ({
        type: 'tool_result',
        tool_use_id: `toolu_${String(index)}`,
        is_error: false,
      })),
    },
  };
}

describe('the commit-cadence instrument', () => {
  /** The test worker sets COMMIT_CADENCE_WARN_AFTER=2, so three results trip it. */
  async function runWith(steps: unknown[], onStart?: () => void) {
    queryMock.mockImplementation(() =>
      scriptedQuery(steps.map((message) => ({ message })))(),
    );
    const runner = new AgentSdkRunner(h.deps);
    const runPromise = runner.run(taskDispatch(), new AbortController().signal);
    onStart?.();
    capturedOutcomeBox!.outcome = { kind: 'complete', summary: 'done' };
    await runPromise;
    return h.broker
      .ofType('limit.exceeded')
      .filter((event) => (event.payload as { limit?: string }).limit === 'commit_cadence');
  }

  beforeEach(async () => {
    await h.close();
    h = await buildTestWorker({ COMMIT_CADENCE_WARN_AFTER: '2' });
  });

  it('stays silent while the agent is committing often enough', async () => {
    const warnings = await runWith([toolResultMessage(), toolResultMessage(), resultMessage()]);
    expect(warnings).toHaveLength(0);
  });

  it('emits one warn-only event once tool calls since the last commit pass the threshold', async () => {
    const warnings = await runWith([
      toolResultMessage(),
      toolResultMessage(),
      toolResultMessage(),
      resultMessage(),
    ]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.severity).toBe('warn');
    expect(warnings[0]?.payload).toMatchObject({
      limit: 'commit_cadence',
      allowed: 2,
      calls_since_commit: 3,
      // It measures; it does not enforce. A hard block on a guessed
      // threshold can deadlock a legitimately long edit-then-test loop.
      enforced: false,
    });
  });

  it('attributes the warning to the task that produced it', async () => {
    queryMock.mockImplementation(() =>
      scriptedQuery(
        [toolResultMessage(), toolResultMessage(), toolResultMessage(), resultMessage()].map(
          (message) => ({ message }),
        ),
      )(),
    );

    const runner = new AgentSdkRunner(h.deps);
    const dispatch = taskDispatch();
    const runPromise = runner.run(dispatch, new AbortController().signal);
    capturedOutcomeBox!.outcome = { kind: 'complete', summary: 'done' };
    await runPromise;

    const warning = h.broker
      .ofType('limit.exceeded')
      .find((event) => (event.payload as { limit?: string }).limit === 'commit_cadence');
    expect(warning?.taskId).toBe(dispatch.task_id);
  });

  it('counts every result in a parallel tool call, not the message', async () => {
    const warnings = await runWith([toolResultMessage(3), resultMessage()]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.payload).toMatchObject({ calls_since_commit: 3 });
  });

  it('warns at most once for the whole task', async () => {
    const warnings = await runWith([
      toolResultMessage(),
      toolResultMessage(),
      toolResultMessage(),
      toolResultMessage(),
      toolResultMessage(),
      resultMessage(),
    ]);
    expect(warnings).toHaveLength(1);
  });

  it('is reset by a commit the git tool records', async () => {
    // Exactly the three results that warn in the test above. The only
    // difference is the commit, so this isolates the reset itself: the first
    // result observes it and lands on zero, leaving two counted calls — at
    // the threshold, not past it.
    queryMock.mockImplementation(() =>
      scriptedQuery([
        { message: toolResultMessage() },
        { message: toolResultMessage() },
        { message: toolResultMessage() },
        { message: resultMessage() },
      ])(),
    );

    const runner = new AgentSdkRunner(h.deps);
    const runPromise = runner.run(taskDispatch(), new AbortController().signal);
    // The `git` tool's handler records the commit before its own tool_result
    // reaches the runner; recording it here as soon as the box exists stands
    // in for that, and the third result observes the reset.
    capturedCommitBox!.commits += 1;
    capturedOutcomeBox!.outcome = { kind: 'complete', summary: 'done' };
    await runPromise;

    const warnings = h.broker
      .ofType('limit.exceeded')
      .filter((event) => (event.payload as { limit?: string }).limit === 'commit_cadence');
    expect(warnings).toHaveLength(0);
  });

  it('gives the git tool a commit box to record into', async () => {
    await runWith([resultMessage()]);
    expect(capturedCommitBox).toEqual({ commits: 0 });
  });
});

/**
 * Subagent observability. The lifecycle events come from hooks rather than
 * from the message stream, so these drive the registered hook callbacks
 * directly — the same way the containment suite above drives `PreToolUse`.
 */
describe('subagent observability', () => {
  async function optionsFor(): Promise<Record<string, unknown>> {
    queryMock.mockImplementation(() => scriptedQuery([{ message: resultMessage() }])());
    const runner = new AgentSdkRunner(h.deps);
    const runPromise = runner.run(taskDispatch(), new AbortController().signal);
    capturedOutcomeBox!.outcome = { kind: 'complete', summary: 'done' };
    await runPromise;
    return (queryMock.mock.calls[0]?.[0] as { options: Record<string, unknown> }).options;
  }

  function hooksOf(
    options: Record<string, unknown>,
    event: string,
  ): Array<(input: unknown) => Promise<unknown>> {
    const registered = options.hooks as Record<string, Array<{ hooks: Array<(i: unknown) => Promise<unknown>> }>>;
    return (registered[event] ?? []).flatMap((entry) => entry.hooks);
  }

  it('announces the roster once, so the dashboard shows the definition that actually ran', async () => {
    await optionsFor();

    const announcements = h.broker
      .ofType('agent.tool_call')
      .filter((event) => (event.payload as { phase?: string }).phase === 'subagent_roster');

    expect(announcements).toHaveLength(1);
    const subagents = (announcements[0]?.payload as { subagents: Array<{ name: string }> }).subagents;
    expect(subagents.map((entry) => entry.name)).toEqual(Object.keys(SUBAGENT_ROSTER));
  });

  it('offers the SDK exactly the roster this module publishes, and no second copy of it', async () => {
    const agents = (await optionsFor()).agents as Record<string, { tools?: string[] }>;

    expect(Object.keys(agents)).toEqual(Object.keys(SUBAGENT_ROSTER));
    for (const [name, spec] of Object.entries(SUBAGENT_ROSTER)) {
      expect(agents[name]?.tools).toEqual([...spec.tools]);
    }
  });

  it('registers a hook for each end of the subagent lifecycle', async () => {
    const options = await optionsFor();

    expect(hooksOf(options, 'SubagentStart')).toHaveLength(1);
    expect(hooksOf(options, 'SubagentStop')).toHaveLength(1);
  });

  it('reports a spawn and a stop, with how long the subagent ran', async () => {
    const options = await optionsFor();
    h.clock.set(new Date(10_000));
    await hooksOf(options, 'SubagentStart')[0]?.({
      hook_event_name: 'SubagentStart',
      agent_id: 'ag_7',
      agent_type: 'explorer',
    });
    h.clock.set(new Date(13_000));
    await hooksOf(options, 'SubagentStop')[0]?.({
      hook_event_name: 'SubagentStop',
      agent_id: 'ag_7',
      agent_type: 'explorer',
      last_assistant_message: 'It is in dispatcher.ts.',
    });

    const phases = h.broker
      .ofType('agent.tool_call')
      .map((event) => event.payload as Record<string, unknown>);

    expect(phases).toContainEqual(
      expect.objectContaining({ phase: 'subagent_start', subagent_id: 'ag_7' }),
    );
    expect(phases).toContainEqual(
      expect.objectContaining({
        phase: 'subagent_stop',
        subagent_id: 'ag_7',
        duration_ms: 3000,
        last_message: 'It is in dispatcher.ts.',
      }),
    );
  });

  it('carries the task id on a lifecycle event, like every other event this runner emits', async () => {
    const options = await optionsFor();
    await hooksOf(options, 'SubagentStart')[0]?.({
      hook_event_name: 'SubagentStart',
      agent_id: 'ag_7',
      agent_type: 'explorer',
    });

    const start = h.broker
      .ofType('agent.tool_call')
      .find((event) => (event.payload as { phase?: string }).phase === 'subagent_start');

    expect(start?.taskId).toBe(taskDispatch().task_id);
  });

  /**
   * The join the whole design rests on: `PreToolUse` is the only place the
   * SDK reports both the tool use id and the subagent that issued it.
   */
  it('attributes a tool call made inside a subagent to that subagent', async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });

    queryMock.mockImplementation(() =>
      scriptedQuery([
        {
          message: assistantMessage({
            content: [{ type: 'tool_use', id: 'toolu_sub', name: 'Grep' }],
          }),
        },
        // Held open so the hook can fire between the tool use and its result,
        // which is the order the SDK itself guarantees.
        { gate },
        {
          message: {
            type: 'user',
            message: {
              content: [{ type: 'tool_result', tool_use_id: 'toolu_sub', is_error: false }],
            },
          },
        },
        { message: resultMessage() },
      ])(),
    );

    const runner = new AgentSdkRunner(h.deps);
    const runPromise = runner.run(taskDispatch(), new AbortController().signal);
    capturedOutcomeBox!.outcome = { kind: 'complete', summary: 'done' };
    await new Promise((resolve) => setTimeout(resolve, 0));

    const options = (queryMock.mock.calls[0]?.[0] as { options: Record<string, unknown> }).options;
    for (const hook of hooksOf(options, 'PreToolUse')) {
      await hook({
        hook_event_name: 'PreToolUse',
        tool_name: 'Grep',
        tool_input: { pattern: 'x' },
        tool_use_id: 'toolu_sub',
        agent_id: 'ag_7',
        agent_type: 'explorer',
      });
    }
    open();
    await runPromise;

    const call = h.broker
      .ofType('agent.tool_call')
      .find((event) => (event.payload as { tool?: string }).tool === 'Grep');

    expect(call?.payload).toMatchObject({ subagent_id: 'ag_7', subagent_type: 'explorer' });
  });

  it('never emits a subagent payload key that looksLikeSecretKey would flag', async () => {
    const options = await optionsFor();
    await hooksOf(options, 'SubagentStart')[0]?.({
      hook_event_name: 'SubagentStart',
      agent_id: 'ag_7',
      agent_type: 'explorer',
    });

    for (const event of h.broker.ofType('agent.tool_call')) {
      for (const key of Object.keys(event.payload ?? {})) {
        expect(looksLikeSecretKey(key)).toBe(false);
      }
    }
  });
});
