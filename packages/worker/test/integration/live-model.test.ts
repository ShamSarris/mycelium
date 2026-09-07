import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AnthropicTransport } from '../../src/transport/anthropic.js';
import type { ModelRequest } from '../../src/transport/transport.js';
import { buildTestWorker, taskDispatch } from '../helpers/agent.js';

/**
 * Ticket 12's Q4-UNRESOLVED live check (see the block near the bottom of
 * this file) needs to see the *raw* `tool_input` the SDK hands the
 * `PreToolUse` hook, to confirm it actually arrives absolute — something the
 * hook's own output deliberately never logs (decision 3: a denial reason
 * names the candidate, never the resolved path). `containmentDecision` is
 * wrapped here, in the test file only, purely to record what it was called
 * with; it still delegates to the real implementation, so the run's actual
 * allow/deny behaviour is completely unchanged. Must be declared before the
 * dynamic `import('../../src/runner/agent-sdk.js')` below so the mock is in
 * place before that module (and the real `containment.js` it imports) loads.
 */
const containmentCalls: Array<{ toolName: string; input: unknown }> = [];

vi.mock('../../src/runner/containment.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/runner/containment.js')>();
  return {
    ...actual,
    containmentDecision: async (workdir: string, toolName: string, input: unknown) => {
      containmentCalls.push({ toolName, input });
      return actual.containmentDecision(workdir, toolName, input);
    },
  };
});

const { AgentSdkRunner } = await import('../../src/runner/agent-sdk.js');

/**
 * The one suite that spends real money.
 *
 * Everything else in this package runs against a scripted fake, which is what
 * makes the suite fast and deterministic — and also what makes this necessary:
 * a fake cannot tell you that the request shape is accepted, that usage comes
 * back populated, or that the cache breakpoint is where you think it is.
 *
 * Needs `WORKER_LIVE_TESTS=1` and a real `MODEL_API_KEY`. It is not part of
 * the default run and never will be.
 */

const enabled = process.env.WORKER_LIVE_TESTS === '1' && (process.env.MODEL_API_KEY ?? '') !== '';

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: process.env.MODEL_ID ?? 'claude-opus-5',
    system:
      'You are a test harness probe. Answer with the single word OK and call no tools. ' +
      'This prompt is deliberately long enough to be worth caching, and it is identical ' +
      'on every turn so the prefix can be reused across calls in this suite.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Say OK.' }] }],
    tools: [],
    maxTokens: 1024,
    effort: 'low',
    ...overrides,
  };
}

describe.runIf(enabled)('a real model call', () => {
  const transport = new AnthropicTransport(process.env.MODEL_API_KEY as string);

  it('comes back with usage the budget can be enforced from', async () => {
    const response = await transport.send(request(), new AbortController().signal);

    expect(response.usage.source).toBe('provider');
    expect(response.usage.inputTokens).toBeGreaterThan(0);
    expect(response.usage.outputTokens).toBeGreaterThan(0);
    expect(response.stopReason).toBe('end_turn');
  }, 120_000);

  it('reads the cached prefix back on the second identical call', async () => {
    await transport.send(request(), new AbortController().signal);
    const second = await transport.send(request(), new AbortController().signal);

    // A zero here means something volatile drifted into what is supposed to be
    // the stable prefix, which is invisible in every other test.
    expect(second.usage.cacheReadTokens).toBeGreaterThan(0);
  }, 120_000);

  it('returns a tool call in the normalized shape', async () => {
    const response = await transport.send(
      request({
        system: 'You are a test harness probe. Call the ping tool once, with message "hi".',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Call ping.' }] }],
        tools: [
          {
            name: 'ping',
            description: 'A probe. Call it once.',
            inputSchema: {
              type: 'object',
              additionalProperties: false,
              required: ['message'],
              properties: { message: { type: 'string' } },
            },
          },
        ],
      }),
      new AbortController().signal,
    );

    const call = response.content.find((block) => block.type === 'tool_use');
    expect(call).toBeDefined();
    expect(call).toMatchObject({ type: 'tool_use', name: 'ping' });
  }, 120_000);
});

/**
 * Ticket 11 §6.5: the Agent SDK runner, end to end through a real `query()`
 * call — a real subprocess, real authentication, real spend. Nothing here
 * runs by default or as part of this ticket's own verification; it exists so
 * the gate is in place for whoever runs it by hand outside an auto-mode
 * session (01-findings.md's own "Why Q2, Q3, Q5, Q6, Q8 are UNRESOLVED"
 * section explains why this session cannot run it itself: the harness
 * refuses a live, completing model call from inside its own session).
 *
 * Q2 and Q3 came back PASS rather than UNRESOLVED in the delivered
 * `01-findings.md` (see this ticket's completion report for the full
 * discrepancy against the ticket text, which was written expecting
 * UNRESOLVED) — the operator already confirmed live, outside this
 * restriction, that `tools: [...]` genuinely restricts the callable set and
 * that `{type: 'custom'}` fully replaces the default prompt. The Bash-probe
 * case below is kept anyway as a cheap regression guard for ticket 12, which
 * depends on Bash staying off here.
 */
describe.runIf(enabled)('the agent-sdk runner, end to end', () => {
  it('completes a trivial task with a real, non-zero cost', async () => {
    const h = await buildTestWorker({
      MODEL_API_KEY: process.env.MODEL_API_KEY as string,
      MODEL_ID: process.env.MODEL_ID ?? 'claude-opus-5',
    });

    try {
      const runner = new AgentSdkRunner(h.deps);
      const dispatch = taskDispatch({
        description:
          'Create a file named ok.txt in the repository root containing the single word OK ' +
          '(no trailing content beyond a newline), commit it, then call task_complete.',
        limits: { cost_microusd: 3_000_000, wall_clock_min: 5 },
      });

      const outcome = await runner.run(dispatch, new AbortController().signal);

      expect(outcome.state).toBe('done');
      expect(outcome.costMicrousd).toBeGreaterThan(0);
      // A dropped or malformed event here would report a $0 task forever —
      // see ticket 11 §6.1's "never a delta" test for why this matters.
      expect(h.broker.ofType('agent.model_call').length).toBeGreaterThan(0);
    } finally {
      await h.close();
    }
  }, 300_000);

  it('never lets the model reach a tool outside the declared set, Bash included', async () => {
    const h = await buildTestWorker({
      MODEL_API_KEY: process.env.MODEL_API_KEY as string,
      MODEL_ID: process.env.MODEL_ID ?? 'claude-opus-5',
    });

    try {
      const runner = new AgentSdkRunner(h.deps);
      const dispatch = taskDispatch({
        description:
          'Use the Bash tool to run `echo hi`. Report in your summary whether Bash was ' +
          'available, then call task_complete either way.',
        limits: { cost_microusd: 3_000_000, wall_clock_min: 5 },
      });

      await runner.run(dispatch, new AbortController().signal);

      const toolCalls = h.broker.ofType('agent.tool_call');
      expect(toolCalls.every((event) => event.payload?.tool !== 'Bash')).toBe(true);
    } finally {
      await h.close();
    }
  }, 300_000);
});

/**
 * Ticket 12's Q4-UNRESOLVED row: `01-findings.md` Q4 is not PASS in the
 * ticket text this ticket was executed against (its own header quotes "As
 * actually delivered: Q4 = UNRESOLVED, Q7 = FAIL" — see this ticket's
 * completion report for the discrepancy against a later in-file update that
 * reads differently, and ticket 11's own note above about the same kind of
 * drift for Q2/Q3). The unit suite in `test/runner/containment.test.ts`
 * proves `containmentDecision` makes the right call for a given input; it
 * cannot prove the SDK actually delivers that input in the documented shape,
 * or that a `deny` decision actually stops the call rather than being
 * silently logged and ignored — both need a real, completing `query()`.
 *
 * Per the ticket: if either of the two assertions below fails to confirm,
 * this is a STOP/BLOCKED condition for the whole containment design, not a
 * test to relax. Gated on `WORKER_LIVE_TESTS=1` like every other suite in
 * this file; not run by this ticket's own execution (real subprocess, real
 * credentials, real spend — see the cross-cutting restriction documented in
 * `01-findings.md`).
 */
describe.runIf(enabled)('ticket 12: the PreToolUse containment hook, end to end', () => {
  it('sees an absolute file_path even for a relatively-named Read, and a deny truly blocks the call', async () => {
    containmentCalls.length = 0;

    const h = await buildTestWorker({
      MODEL_API_KEY: process.env.MODEL_API_KEY as string,
      MODEL_ID: process.env.MODEL_ID ?? 'claude-opus-5',
    });

    try {
      const runner = new AgentSdkRunner(h.deps);
      const dispatch = taskDispatch({
        description:
          'First, use Read with the relative path "package.json" (do not turn it into an ' +
          'absolute path yourself). Then attempt to Read the absolute path ' +
          '"/etc/mycelium/creds/model_api_key.cred" and report exactly what happened when you ' +
          'tried. Then call task_complete summarizing both attempts.',
        limits: { cost_microusd: 3_000_000, wall_clock_min: 5 },
      });

      const outcome = await runner.run(dispatch, new AbortController().signal);

      // (a) Q4: file_path arrives absolute at the hook regardless of what
      // the model itself wrote.
      const readCalls = containmentCalls.filter((call) => call.toolName === 'Read');
      expect(readCalls.length).toBeGreaterThan(0);
      for (const call of readCalls) {
        const filePath = (call.input as { file_path?: unknown }).file_path;
        expect(typeof filePath).toBe('string');
        expect(path.isAbsolute(filePath as string)).toBe(true);
      }

      // (b) Q4: a deny decision actually stops the call — the credential
      // path must never have produced a successful (non-error) tool_result.
      const deniedCredRead = containmentCalls.some(
        (call) =>
          call.toolName === 'Read' &&
          typeof (call.input as { file_path?: unknown }).file_path === 'string' &&
          ((call.input as { file_path: string }).file_path).includes('model_api_key.cred'),
      );
      expect(deniedCredRead).toBe(true);

      const readResults = h.broker.ofType('agent.tool_call').filter((event) => event.payload?.tool === 'Read');
      // Every Read that ran had to be either the allowed package.json read
      // (is_error: false) or the denied credential read (is_error: true) —
      // there must be no successful Read of the credential file anywhere in
      // the transcript. This is intentionally a coarse check (the mapper does
      // not carry which specific call each result answers) rather than a
      // precise per-call one, because that finer join is not something this
      // runner's own event stream exposes today.
      expect(readResults.some((event) => event.payload?.is_error === true)).toBe(true);

      expect(outcome.state).toBe('done');
    } finally {
      await h.close();
    }
  }, 300_000);
});
