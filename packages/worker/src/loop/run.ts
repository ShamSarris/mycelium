import type { Deps } from '../deps.js';
import { cumulative, estimateTokens, openBudget, record, reserve, type Budget } from '../domain/budget.js';
import type { TaskDispatch } from '../protocol.js';
import type { TaskOutcome } from '../runner/runner.js';
import type { ToolOutcome, ToolRegistry } from '../tools/registry.js';
import type { ContentBlock, ModelRequest, ModelResponse, ModelTransport } from '../transport/transport.js';
import { NUDGE, openingMessage, systemPrompt } from './prompt.js';
import { Conversation } from './state.js';

// `TaskOutcome`'s canonical home is `runner/runner.ts` (ticket 09) — it is
// the return type of the `TaskRunner` seam now, not just this loop's. Kept
// re-exported here so nothing importing it from its old home breaks.
export type { TaskOutcome } from '../runner/runner.js';

/**
 * `Deps` plus the `ModelTransport` this loop calls directly. `HostLoopRunner`
 * holds the transport and assembles this from it and the `Deps` it was given,
 * so nothing above `HostLoopRunner` needs to know this loop still speaks to a
 * transport at all — that seam is `runner/runner.ts` now.
 */
export type HostLoopDeps = Deps & { transport: ModelTransport };

/**
 * The host-owned agent loop.
 *
 * It ends for exactly one of a fixed set of reasons, and every one of them is
 * decided here rather than by the model: a terminating tool call, a limit, an
 * abort, a refusal, or a transport failure. "The model stopped producing tool
 * calls" is not on that list — it gets one nudge and then fails, because
 * silence must never be indistinguishable from success.
 *
 * The loop never retries anything. Failure policy is the orchestrator's, and
 * an agent that retried on its own would spend a task's budget against a
 * ceiling the orchestrator thought it still had.
 */

export async function runTask(
  deps: HostLoopDeps,
  dispatch: TaskDispatch,
  tools: ToolRegistry,
  signal: AbortSignal,
): Promise<TaskOutcome> {
  const { config, clock } = deps;
  const taskId = dispatch.task_id;

  const conversation = new Conversation(openingMessage(dispatch));
  const system = systemPrompt(config);
  const declarations = tools.declarations();

  let budget = openBudget(dispatch.limits.cost_microusd, dispatch.cost_spent_so_far_microusd);
  const deadline = clock.now().getTime() + dispatch.limits.wall_clock_min * 60_000;
  let nudged = false;

  // The commit-cadence instrument (ticket 0004 section 9.3). It measures; it
  // does not enforce. The threshold is a guess until there is data behind it,
  // and a hard block on a guessed number can deadlock a legitimately long
  // edit-then-test loop into a commit-refuse-commit cycle.
  let sinceCommit = 0;
  let cadenceWarned = false;

  const done = (outcome: Omit<TaskOutcome, 'costMicrousd' | 'tokensSpent'>): TaskOutcome => ({
    ...outcome,
    costMicrousd: cumulative(budget),
    tokensSpent: cumulative(budget),
  });

  const failed = (error: string): TaskOutcome => done({ state: 'failed', error });

  const abort = async (): Promise<TaskOutcome> => {
    // Emitted before anything networked is attempted. This goes to a local,
    // fsynced spool in milliseconds; the status report crosses the network,
    // and B15 gives the whole shutdown five seconds.
    await deps.broker.emit({
      type: 'error',
      severity: 'warn',
      taskId,
      payload: { stage: 'aborted', reason: abortReason(signal) },
    });
    return failed(`aborted: ${abortReason(signal)}`);
  };

  for (;;) {
    if (signal.aborted) return abort();

    if (clock.now().getTime() >= deadline) {
      await emitLimit(deps, taskId, {
        limit: 'wall_clock_min',
        allowed: dispatch.limits.wall_clock_min,
      });
      return failed(`limit_exceeded: the task passed its ${dispatch.limits.wall_clock_min} minute wall clock`);
    }

    const request: ModelRequest = {
      model: config.modelId,
      system,
      messages: conversation.snapshot(),
      tools: declarations,
      maxTokens: config.modelMaxTokens,
      effort: config.modelEffort,
    };

    // Fail closed, before the call. Checking afterwards would only ever report
    // an overrun that had already been paid for.
    const reservation = reserve(
      budget,
      estimateTokens(serialiseForEstimate(request), config.bytesPerToken),
      config.modelMaxTokens,
    );
    if (!reservation.ok) {
      await emitLimit(deps, taskId, {
        limit: 'tokens',
        allowed: dispatch.limits.cost_microusd,
        spent: cumulative(budget),
      });
      return failed(`limit_exceeded: ${reservation.message}`);
    }

    let response: ModelResponse;
    try {
      response = await deps.transport.send(request, signal);
    } catch (error) {
      if (signal.aborted) return abort();
      await deps.broker.emit({
        type: 'error',
        severity: 'error',
        taskId,
        payload: { stage: 'model_call', message: (error as Error).message },
      });
      return failed(`transport_error: ${(error as Error).message}`);
    }

    budget = record(budget, response.usage);
    await deps.broker.emit({
      type: 'agent.model_call',
      taskId,
      payload: {
        model: config.modelId,
        stop_reason: response.stopReason,
        // Task-wide cumulative, never a delta: a dropped event on a bounded
        // spool must not lose spend, and a retry must not reset the total.
        tokens_total: cumulative(budget),
        tokens_this_attempt: budget.attemptSpend,
        // Mirrors the token totals for now: domain/budget.ts is not converted
        // to cost (ticket 07 decision, deleted by ticket 14), so there is no
        // real cost figure yet. Real cost tracking arrives with tickets 09-11.
        cost_total_microusd: cumulative(budget),
        cost_this_attempt_microusd: budget.attemptSpend,
        input_tokens: response.usage.inputTokens,
        output_tokens: response.usage.outputTokens,
        cache_read_tokens: response.usage.cacheReadTokens,
        // Counts toward the budget (domain/budget.ts totalTokens) but was
        // never emitted until now — a pre-existing reporting gap.
        cache_write_tokens: response.usage.cacheWriteTokens,
        usage_source: response.usage.source,
      },
    });

    if (response.stopReason === 'refusal') {
      // Visible rather than routed around. A task that trips a safety
      // classifier is something the operator should see.
      const category = response.refusal?.category ?? 'unknown';
      return failed(`refusal: the model declined this task (${category})`);
    }

    conversation.appendAssistant(response.content);

    if (response.stopReason === 'max_tokens') {
      return failed(
        `max_tokens: the model filled its ${config.modelMaxTokens} token output budget without finishing a turn`,
      );
    }

    const calls = response.content.filter(
      (block): block is Extract<ContentBlock, { type: 'tool_use' }> => block.type === 'tool_use',
    );

    if (calls.length === 0) {
      if (nudged) {
        return failed('no_terminal_call: the model produced no tool call twice running');
      }
      nudged = true;
      conversation.appendUserText(NUDGE);
      continue;
    }

    // Parallel calls run concurrently and their results go back together.
    const outcomes = await Promise.all(
      calls.map(async (call) => ({
        call,
        outcome: await invoke(deps, tools, call, taskId),
      })),
    );

    const terminal = outcomes.find(({ outcome }) => outcome.kind !== 'result');
    if (terminal !== undefined) {
      return terminalOutcome(terminal.outcome, done);
    }

    for (const { outcome } of outcomes) {
      sinceCommit = outcome.kind === 'result' && outcome.committed === true ? 0 : sinceCommit + 1;
    }

    if (!cadenceWarned && sinceCommit > config.commitCadenceWarnAfter) {
      cadenceWarned = true;
      await emitLimit(deps, taskId, {
        limit: 'commit_cadence',
        allowed: config.commitCadenceWarnAfter,
        calls_since_commit: sinceCommit,
        enforced: false,
      });
    }

    conversation.appendToolResults(
      outcomes.map(({ call, outcome }) => ({
        type: 'tool_result' as const,
        toolUseId: call.id,
        content: outcome.kind === 'result' ? outcome.content : '',
        isError: outcome.kind === 'result' ? outcome.isError : false,
      })),
    );
  }
}

async function invoke(
  deps: Deps,
  tools: ToolRegistry,
  call: Extract<ContentBlock, { type: 'tool_use' }>,
  taskId: string,
): Promise<ToolOutcome> {
  const started = deps.clock.now().getTime();

  try {
    const outcome = await tools.invoke({ id: call.id, name: call.name, input: call.input, taskId });
    await deps.broker.emit({
      type: 'agent.tool_call',
      taskId,
      severity: outcome.kind === 'result' && outcome.isError ? 'warn' : 'info',
      payload: {
        tool: call.name,
        outcome: outcome.kind,
        is_error: outcome.kind === 'result' ? outcome.isError : false,
        duration_ms: deps.clock.now().getTime() - started,
      },
    });
    return outcome;
  } catch (error) {
    // A tool that threw is a bug in this process, not a model error — but the
    // model still needs an answer for the call it made, or the next request
    // would be missing a result and be refused by the API.
    await deps.broker.emit({
      type: 'error',
      severity: 'error',
      taskId,
      payload: { stage: 'tool_call', tool: call.name, message: (error as Error).message },
    });
    return { kind: 'result', content: `the ${call.name} tool failed: ${(error as Error).message}`, isError: true };
  }
}

function terminalOutcome(
  outcome: ToolOutcome,
  done: (outcome: Omit<TaskOutcome, 'costMicrousd' | 'tokensSpent'>) => TaskOutcome,
): TaskOutcome {
  if (outcome.kind === 'complete') {
    return done({
      state: 'done',
      result: {
        summary: outcome.summary,
        ...(outcome.commitSha === undefined ? {} : { commit_sha: outcome.commitSha }),
        ...(outcome.notes === undefined ? {} : { notes: outcome.notes }),
      },
    });
  }

  if (outcome.kind === 'failed') {
    return done({ state: 'failed', error: `${outcome.errorClass}: ${outcome.detail}` });
  }

  /* c8 ignore next */
  return done({ state: 'failed', error: 'no_terminal_call: unreachable' });
}

async function emitLimit(
  deps: Deps,
  taskId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await deps.broker.emit({ type: 'limit.exceeded', severity: 'warn', taskId, payload });
}

/**
 * What the estimator measures. Serialising the whole request rather than the
 * messages alone is the conservative reading: the system prompt and the tool
 * schemas are input too, and the estimator's job is to over-state.
 */
function serialiseForEstimate(request: ModelRequest): string {
  return JSON.stringify({
    system: request.system,
    messages: request.messages,
    tools: request.tools,
  });
}

/**
 * The teardown reason, when shutdown put one on the signal. `AbortSignal`
 * carries a `reason` and shutdown sets it, so the task's failure can name why
 * it ended rather than saying only that it did.
 */
function abortReason(signal: AbortSignal): string {
  const reason: unknown = signal.reason;
  if (typeof reason === 'string' && reason !== '') return reason;
  return 'the environment is being torn down';
}
