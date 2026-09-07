import {
  query,
  type AgentDefinition,
  type HookCallback,
  type Options,
  type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { Deps } from '../deps.js';
import type { TaskDispatch } from '../protocol.js';
import { createContainmentHook } from './containment.js';
import { cumulativeTokens, initialMapperState, mapSdkMessage, type MapperMessage, type MapperState } from './events.js';
import { openingMessage, systemPrompt } from './prompt.js';
import type { TaskOutcome, TaskRunner } from './runner.js';
import { buildMyceliumServer, createTerminalOutcomeBox } from './tools.js';

/**
 * The Agent SDK's `query()` as a `TaskRunner` (ticket 11).
 *
 * The ONLY file in `packages/worker/src` allowed to import
 * `@anthropic-ai/claude-agent-sdk` (ticket 11 §3; ticket 14 adds the guard
 * test). Everything above this file — `task.ts`, `deps.ts`, `index.ts` — goes
 * through the `TaskRunner` interface and knows nothing about the SDK.
 *
 * The turn loop, conversation state, and context compaction all move inside
 * `query()` now. What stays here, reproducing the host loop's own behaviour
 * (`loop/run.ts`) on top of a framework that owns its loop internally:
 *
 * - The wall clock, which the SDK has no stop condition for at all.
 * - "Silence is never success": a run that ends without `task_complete` or
 *   `task_failed` fails with `no_terminal_call`, exactly as before.
 * - A visible failure on refusal, not a silently-retried one.
 * - No retries — failure policy belongs to the orchestrator.
 *
 * Abort is best-effort, not a guarantee. `01-findings.md` Q5 measured this
 * live: the SDK's own internal cleanup after `abortController.abort()`
 * budgets up to ~7s (a 2s grace window, then SIGTERM, then up to another 5s
 * before SIGKILL) before the `claude` subprocess actually exits, and both of
 * those internal timers are `.unref()`'d — if this process exits first for
 * any reason, the subprocess is orphaned with nothing left to kill it. A real
 * run in the spike reproduced exactly that. Because of this, `run()` never
 * awaits the SDK's own `for await` loop settling once an abort or the wall
 * clock has been decided: it races the loop against those two conditions and
 * returns as soon as one of them wins, so the event that has to reach the
 * broker in milliseconds is never held hostage by a subprocess that might
 * take seconds — or, in the worst case, might never exit at all. This
 * process does NOT guarantee the `claude` binary is dead when `run()`
 * returns; that guarantee has to come from the supervisor's external
 * `systemd-run --scope` kill (ticket 15), independent of anything here.
 */
export class AgentSdkRunner implements TaskRunner {
  constructor(private readonly deps: Deps) {}

  async run(dispatch: TaskDispatch, signal: AbortSignal): Promise<TaskOutcome> {
    const { deps } = this;
    const { config } = deps;
    const taskId = dispatch.task_id;

    const outcomeBox = createTerminalOutcomeBox();
    const mcpServer = buildMyceliumServer(deps, outcomeBox, taskId);
    const mapperState = initialMapperState(dispatch.cost_spent_so_far_microusd);

    // Bridges the caller's `AbortSignal` into the `AbortController` `Options`
    // actually wants. The SDK's own type is `abortController?: AbortController`,
    // not an `abortSignal` the way the plan's sketch assumed — see the
    // completion report's deviations. One controller drives both the
    // caller's own cancellation and the host-enforced wall clock below, so
    // either can stop the same `query()` call.
    const controller = new AbortController();

    let timedOut = false;
    let externallyAborted = false;
    let refusalCategory: string | null | undefined;
    let loopError: Error | undefined;
    let finalResult: SDKResultMessage | null = null;

    let settleRace: ((label: RaceLabel) => void) | undefined;
    const race = new Promise<RaceLabel>((resolve) => {
      settleRace = resolve;
    });

    const onExternalAbort = (): void => {
      if (externallyAborted) return;
      externallyAborted = true;
      controller.abort(signal.reason);
      // Emitted before anything networked is attempted: this goes to a
      // local, fsynced spool in milliseconds, while the status report
      // crosses the network and B15 gives the whole shutdown five seconds.
      void deps.broker.emit({
        type: 'error',
        severity: 'warn',
        taskId,
        payload: { stage: 'aborted', reason: abortReason(signal) },
      });
      settleRace?.('aborted');
    };

    if (signal.aborted) onExternalAbort();
    else signal.addEventListener('abort', onExternalAbort, { once: true });

    const deadlineMs = dispatch.limits.wall_clock_min * 60_000;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort('wall_clock_exceeded');
      void deps.broker.emit({
        type: 'limit.exceeded',
        severity: 'warn',
        taskId,
        payload: { limit: 'wall_clock_min', allowed: dispatch.limits.wall_clock_min },
      });
      settleRace?.('timedOut');
    }, deadlineMs);
    // Node keeps a live timer's process open; a finished task must not be
    // kept alive by a wall-clock guard it no longer needs.
    timer.unref?.();

    const consume = (async (): Promise<void> => {
      try {
        for await (const message of query({
          prompt: openingMessage(dispatch),
          options: buildOptions(deps, dispatch, mcpServer, controller),
        })) {
          const events = mapSdkMessage(message as unknown as MapperMessage, mapperState);
          for (const event of events) {
            await deps.broker.emit({ ...event, taskId });
          }

          if (isAssistantMessage(message) && message.message.stop_reason === 'refusal') {
            // Visible, not routed around: fail here rather than letting the
            // SDK's own automatic fallback-model retry quietly paper over a
            // policy trip the operator should see.
            refusalCategory = message.message.stop_details?.category ?? null;
            controller.abort('refusal');
            break;
          }

          if (message.type === 'result') {
            finalResult = message as SDKResultMessage;
          }
        }
      } catch (error) {
        // 01-findings.md Q5: the SDK's own abort/cleanup path can reject
        // ("...aborted by user") well after the fact instead of exiting
        // promptly. If this process is the one that called abort(), that
        // rejection is expected — swallow it here rather than letting it
        // propagate as an uncaught rejection, which is exactly what caused
        // the orphaning in the spike's reproduction. Anything else is a
        // genuine failure.
        if (!controller.signal.aborted) {
          loopError = error as Error;
        }
      }
    })();

    void consume.then(() => settleRace?.('completed'));

    const label = await race;
    clearTimeout(timer);
    signal.removeEventListener('abort', onExternalAbort);

    const bestEffort = (): { costMicrousd: number; tokensSpent: number } => {
      const tokens = cumulativeTokens(mapperState);
      return { costMicrousd: tokens, tokensSpent: tokens };
    };

    if (label === 'timedOut') {
      return {
        state: 'failed',
        error: `limit_exceeded: the task passed its ${dispatch.limits.wall_clock_min} minute wall clock`,
        ...bestEffort(),
      };
    }

    if (label === 'aborted') {
      return { state: 'failed', error: `aborted: ${abortReason(signal)}`, ...bestEffort() };
    }

    // label === 'completed': `consume` has fully settled, so it is safe to
    // read everything it produced.

    if (loopError !== undefined) {
      await deps.broker.emit({
        type: 'error',
        severity: 'error',
        taskId,
        payload: { stage: 'model_call', message: loopError.message },
      });
      return { state: 'failed', error: `transport_error: ${loopError.message}`, ...bestEffort() };
    }

    if (refusalCategory !== undefined) {
      return {
        state: 'failed',
        error: `refusal: the model declined this task (${refusalCategory ?? 'unknown'})`,
        ...bestEffort(),
      };
    }

    const spend = computeSpend(finalResult, dispatch.cost_spent_so_far_microusd, mapperState);

    if (outcomeBox.outcome?.kind === 'complete') {
      const completion = outcomeBox.outcome;
      return {
        state: 'done',
        costMicrousd: spend.costMicrousd,
        tokensSpent: spend.tokensSpent,
        result: {
          summary: completion.summary,
          ...(completion.commitSha === undefined ? {} : { commit_sha: completion.commitSha }),
          ...(completion.notes === undefined ? {} : { notes: completion.notes }),
        },
      };
    }

    if (outcomeBox.outcome?.kind === 'failed') {
      return {
        state: 'failed',
        error: `${outcomeBox.outcome.errorClass}: ${outcomeBox.outcome.detail}`,
        costMicrousd: spend.costMicrousd,
        tokensSpent: spend.tokensSpent,
      };
    }

    // Per ticket 10 §"the terminal-tool signalling mechanism": a null
    // outcome box means the loop ended without either terminating tool being
    // called. Silence is never success.
    return {
      state: 'failed',
      error: 'no_terminal_call: the model ended the run without calling task_complete or task_failed',
      costMicrousd: spend.costMicrousd,
      tokensSpent: spend.tokensSpent,
    };
  }
}

type RaceLabel = 'aborted' | 'timedOut' | 'completed';

/** Structural — narrows an `SDKMessage` enough to read the one field this needs. */
interface AssistantLike {
  type: 'assistant';
  message: { stop_reason?: string | null; stop_details?: { category?: string | null } | null };
}

function isAssistantMessage(message: { type: string }): message is AssistantLike {
  return message.type === 'assistant';
}

// Ticket 13: `Agent` is the SDK's own subagent-spawning tool (its tool_use
// blocks name it `Agent`; only the older `system:init` tools listing still
// calls it `Task` — a naming quirk of the installed 0.3.263 SDK, not a typo
// here). Without it in `tools`, `AGENTS` below is inert: Q2 (01-findings.md,
// confirmed live) established that `tools` restricts the model's own
// callable set, so a tool left out of this list is never even attempted,
// `agents` map or not.
const AGENT_SDK_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Agent'] as const;

const MCP_TOOL_NAMES = [
  'mcp__mycelium__sandbox',
  'mcp__mycelium__git',
  'mcp__mycelium__task_complete',
  'mcp__mycelium__task_failed',
] as const;

/**
 * Ticket 13 §6.2 — the v1 subagent roster. Deliberately one agent, not a
 * fleet (§9's own instruction: "do not add a speculative fleet"): a
 * read-only explorer that can search and read the checkout without writing
 * to the main agent's own context window. `tools` here is a proper subset of
 * `AGENT_SDK_TOOLS` above — no `Write`, `Edit`, or `Agent` (no nesting; spawn
 * depth is separately fixed to 1 via `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`
 * below) — which `test/runner/agent-sdk.test.ts`'s "subagents and
 * concurrency" suite asserts generically, not just for this one entry, so a
 * later addition to this roster is held to the same rule.
 *
 * `effort: 'low'`, independent of `config.modelEffort`: an explorer's job is
 * cheap, bounded search and summarization, not the deep reasoning the main
 * task may need — running it at the parent's own effort would spend more
 * than the work justifies.
 */
const AGENTS: Record<string, AgentDefinition> = {
  explorer: {
    description:
      'Read-only search and reconnaissance of the checkout: finding where something lives, ' +
      'how a piece of code is structured, or gathering context before an edit. Cannot write or ' +
      'edit files. Use this instead of reading many files directly when the goal is to locate ' +
      'or summarize something, so that exploration does not fill the main context.',
    prompt:
      'You search and read the checkout to answer a specific question or locate specific code. ' +
      'Report what you find concisely. You cannot write or edit files — if the task turns out to ' +
      'require a change, say so in your report rather than attempting one.',
    tools: ['Read', 'Glob', 'Grep'],
    effort: 'low',
  },
};

function buildOptions(
  deps: Deps,
  dispatch: TaskDispatch,
  mcpServer: ReturnType<typeof buildMyceliumServer>,
  controller: AbortController,
): Options {
  const { config } = deps;

  return {
    model: config.modelId,
    // `{type: 'custom', prompt}` is what 01-findings.md Q3 confirmed live to
    // fully replace Claude Code's default prompt (Harness/Session-specific/
    // Memory/Environment/CLAUDE.md content all dropped); `preset`+`append`
    // keeps all of it, which would mean Mycelium's prompt is an addition to
    // Claude Code's own persona rather than the whole of it.
    systemPrompt: { type: 'custom', prompt: systemPrompt(config) },
    cwd: config.workdir,
    // 01-findings.md Q2, confirmed live: `tools: [...]` restricts the
    // model's own callable set, not a downstream permission check — the
    // excluded tools never even appear as attempted calls. Ticket 12 adds
    // `Bash` after checking Q7; this ticket does not enable it.
    tools: [...AGENT_SDK_TOOLS],
    // `dontAsk` denies anything not pre-approved rather than prompting —
    // there is nobody here to prompt. `allowedTools` is confirmed (sdk.d.ts)
    // to be exactly what "pre-approved" means: "tool names that are
    // auto-allowed without prompting for permission." Every tool this agent
    // may call, built-in and MCP alike, has to be named here or `dontAsk`
    // would silently refuse it — not in the plan's sketch; see the
    // completion report.
    allowedTools: [...AGENT_SDK_TOOLS, ...MCP_TOOL_NAMES],
    permissionMode: 'dontAsk',
    mcpServers: { mycelium: mcpServer },
    // Ticket 13: the v1 subagent roster. A subagent's own `tools` (above) is
    // never wider than this session's own `tools` list — the Agent SDK's
    // docs describe a subagent as inheriting "the built-in tools ...
    // available in the main conversation", not the full built-in catalog —
    // so nothing here can reach beyond what the main agent could already do.
    agents: AGENTS,
    // Ticket 12: contains the built-in file tools to the plan checkout.
    // `containment.ts` is structural (it must not import this SDK package —
    // see its own header comment), so the cast happens here, at the one
    // file this ticket set allows to know the SDK's own hook types. Q7 =
    // FAIL (01-findings.md): `Bash` stays out of `tools` above, so this
    // hook only ever sees Read/Write/Edit/Glob/Grep and this file's own MCP
    // tools — see `17-credential-relocation.md` for the deferred follow-up
    // that would let Bash be reconsidered.
    hooks: {
      PreToolUse: [
        { hooks: [createContainmentHook(deps, dispatch.task_id, config.workdir) as unknown as HookCallback] },
      ],
    },
    // Isolation is mandatory and `settingSources: []` alone is not enough —
    // it does not suppress auto-memory or claude.ai connectors. All six
    // settings below are required; the VM's real `~/.claude` must never
    // influence an operator-approved plan.
    settingSources: [],
    persistSession: false,
    // Checked after a turn is tallied, so this can overshoot by up to one
    // turn — a known, accepted regression from the old fail-closed pre-call
    // reservation (ticket 11 §3). Do not reinstate a pre-call gate here.
    maxBudgetUsd: dispatch.limits.cost_microusd / 1_000_000,
    abortController: controller,
    env: {
      // `Options.env`, when set, REPLACES the subprocess environment
      // entirely rather than merging with it (sdk.d.ts) — PATH/HOME etc.
      // have to be carried over explicitly or the subprocess cannot even
      // start.
      ...process.env,
      CLAUDE_CONFIG_DIR: config.claudeConfigDir,
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
      // The supervisor injects the model credential as MODEL_API_KEY, not
      // ANTHROPIC_API_KEY — the subprocess `claude` binary authenticates via
      // the latter, so it has to be mapped across explicitly. Not named in
      // the plan's sketch ("the four isolation vars"); see the completion
      // report.
      ANTHROPIC_API_KEY: config.credentials.modelApiKey,
      // Ticket 13: caps subagent concurrency and nesting. The SDK fails a
      // spawn once the concurrency cap is hit rather than queueing it
      // (§3/§9) — `maxConcurrentSubagents` is supervisor-derived from the
      // plan's actual memory ceiling (`config.ts`,
      // `packages/supervisor/src/domain/concurrency.ts`), not read from the
      // plan itself, since the operator has no visibility into the VM.
      CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: String(config.maxConcurrentSubagents),
      // Fixed, not configurable: no nested subagents in v1 (§3) — nesting
      // multiplies the memory footprint this same ticket is trying to bound,
      // and nothing in the v1 design needs it.
      CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1',
    },
  };
}

/**
 * The authoritative cost, computed by summing `modelUsage` — never `usage`,
 * which excludes subagents and the internal auxiliary calls 01-findings.md
 * Q6 found on every run, even a trivial single-turn one. `finalResult` is
 * null only when the run ended before the SDK ever emitted its one `result`
 * message (a crash, or an abort/timeout — both of which are handled by their
 * own early-return branches before this is ever called with a null result in
 * practice; kept defensive rather than assumed).
 */
function computeSpend(
  finalResult: SDKResultMessage | null,
  priorSpendMicrousd: number,
  mapperState: MapperState,
): { costMicrousd: number; tokensSpent: number } {
  if (finalResult === null) {
    const tokens = cumulativeTokens(mapperState);
    return { costMicrousd: tokens, tokensSpent: tokens };
  }

  let costUsd = 0;
  let tokens = 0;
  for (const usage of Object.values(finalResult.modelUsage)) {
    costUsd += usage.costUSD;
    tokens += usage.inputTokens + usage.outputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
  }

  return {
    costMicrousd: priorSpendMicrousd + Math.round(costUsd * 1_000_000),
    // `tokensSpent` is "kept as a detail alongside cost" (runner.ts) — this
    // attempt's real total from `modelUsage`, deliberately NOT added to
    // `priorSpendMicrousd`, which is a cost figure (microusd), not a token
    // count. Mixing the two units the way the pre-ticket-11 mirror did would
    // trade one known inaccuracy for a worse one now that a real number is
    // available for the field that matters (`costMicrousd`).
    tokensSpent: tokens,
  };
}

/** The teardown reason, when shutdown put one on the signal — same as `loop/run.ts`. */
function abortReason(signal: AbortSignal): string {
  const reason: unknown = signal.reason;
  if (typeof reason === 'string' && reason !== '') return reason;
  return 'the environment is being torn down';
}
