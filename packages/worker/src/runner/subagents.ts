import type { AgentEvent } from '../broker.js';
import type { ModelEffort } from '../config.js';

/**
 * Subagent observability, and the roster it observes.
 *
 * The roster lives here rather than in `runner/agent-sdk.ts` for the same
 * reason `runner/events.ts` and `runner/containment.ts` live outside it: this
 * module must never import `@anthropic-ai/claude-agent-sdk` (ticket 11 §3,
 * guarded by the seam test), and the roster now has a second consumer that
 * has nothing to do with the SDK — the announcement below, which is how the
 * dashboard learns which definition a subagent is actually running. A
 * `SubagentSpec` satisfies the SDK's own `AgentDefinition` structurally, so
 * `agent-sdk.ts` adapts rather than duplicates.
 *
 * --- What is observable, and what is not ---
 *
 * The agent may emit exactly four event types (`src/events.ts`) and the
 * event schema's `type` enum is closed with `additionalProperties: false`,
 * so nothing here invents a type. Every payload below rides
 * `agent.tool_call` under a `phase` key — the precedent compaction set when
 * it rode `agent.model_call` with `phase: 'compaction'`, and a defensible
 * fit here because a subagent *is* an invocation of the SDK's `Agent` tool.
 *
 * Per-subagent *cost* is deliberately absent. The SDK's `modelUsage` breaks
 * spend down by model, never by subagent, so a cost column here could only
 * ever be apportioned — and an apportioned number on the page an operator
 * uses to decide whether a plan is worth its budget is worse than no number.
 *
 * --- The join ---
 *
 * Two halves of the SDK report subagent activity and neither shares an
 * identifier with the other: the `SubagentStart`/`SubagentStop` hooks speak
 * in `agent_id`, and the message stream speaks in `parent_tool_use_id`. What
 * bridges them is `PreToolUse`, the one input carrying both `tool_use_id`
 * and (inside a subagent) `agent_id` — and `tool_use_id` is already the key
 * `runner/events.ts` files pending tool names under. So the hook writes into
 * the box below and the mapper reads from it, joining on a value neither had
 * to invent.
 *
 * The box is the third use of the mutable-box pattern in this runner, after
 * `TerminalOutcomeBox` and `CommitBox`; see `runner/tools.ts`'s header for
 * why a hook has no other channel back to whatever drives `query()`.
 */

export interface SubagentSpec {
  readonly description: string;
  readonly prompt: string;
  readonly tools: readonly string[];
  readonly effort: ModelEffort;
  /** Explicit finite bound; Agent SDK subagents otherwise inherit an unbounded loop. */
  readonly maxTurns: number;
}

/**
 * Ticket 13 §6.2 — the v1 subagent roster. Deliberately one agent, not a
 * fleet (§9's own instruction: "do not add a speculative fleet"): a
 * read-only explorer that can search and read the checkout without writing
 * to the main agent's own context window. Its `tools` are a proper subset of
 * `agent-sdk.ts`'s own `AGENT_SDK_TOOLS` — no `Write`, `Edit`, or `Agent`
 * (no nesting; spawn depth is separately fixed to 1) — which that file's
 * "subagents and concurrency" suite asserts generically rather than for this
 * one entry, so a later addition is held to the same rule.
 *
 * `effort: 'low'`, independent of `config.modelEffort`: an explorer's job is
 * cheap, bounded search and summarization, not the deep reasoning the main
 * task may need — running it at the parent's own effort would spend more
 * than the work justifies.
 */
export const SUBAGENT_ROSTER: Readonly<Record<string, SubagentSpec>> = {
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
    maxTurns: 12,
  },
};

/**
 * The roster as the run actually configured it, emitted once per task.
 *
 * Sent rather than read from the orchestrator's own copy on purpose: there
 * is no copy to read. The roster is worker code, the dashboard is a separate
 * package that cannot import it, and duplicating it there would drift the
 * first time either side is deployed without the other. What the operator
 * sees is therefore what the agent ran, not what this version of the
 * orchestrator believes it would have run.
 */
export function rosterAnnouncement(): AgentEvent {
  return {
    type: 'agent.tool_call',
    payload: {
      phase: 'subagent_roster',
      subagents: Object.entries(SUBAGENT_ROSTER).map(([name, spec]) => ({
        name,
        description: spec.description,
        prompt: spec.prompt,
        tools: [...spec.tools],
        effort: spec.effort,
        max_turns: spec.maxTurns,
      })),
    },
  };
}

export interface SubagentBox {
  /** `tool_use_id` -> the subagent that issued it. Written by `PreToolUse`. */
  readonly byToolUse: Map<string, { subagent_id: string; subagent_type: string }>;
  /** `agent_id` -> epoch ms of its `SubagentStart`, so the stop can report a duration. */
  readonly startedAt: Map<string, number>;
}

export function createSubagentBox(): SubagentBox {
  return { byToolUse: new Map(), startedAt: new Map() };
}

/** What `PreToolUse` gives us. Structural: the SDK's `PreToolUseHookInput` satisfies it. */
export interface ToolUseAttribution {
  tool_use_id?: string;
  agent_id?: string;
  agent_type?: string;
}

/**
 * Records a tool call for the mapper to attribute later.
 *
 * `agent_id` — not `agent_type` — is what decides, on the SDK's own
 * instruction: `agent_type` is also set on the main thread of a session
 * started with `--agent`, and only `agent_id` is documented as "present only
 * when the hook fires from within a subagent".
 */
export function noteToolUse(box: SubagentBox, input: ToolUseAttribution): void {
  if (input.tool_use_id === undefined || input.agent_id === undefined) return;
  box.byToolUse.set(input.tool_use_id, {
    subagent_id: input.agent_id,
    subagent_type: input.agent_type ?? 'unknown',
  });
}

/**
 * Resolves a tool result to the subagent that issued it, and forgets it.
 *
 * The forgetting is not tidiness: one `tool_use_id` is answered exactly once,
 * and without it the map would grow for the whole life of a task that may run
 * for hours.
 */
export function attribution(
  box: SubagentBox,
  toolUseId: string,
): { subagent_id: string; subagent_type: string } | null {
  const found = box.byToolUse.get(toolUseId);
  if (found === undefined) return null;
  box.byToolUse.delete(toolUseId);
  return found;
}

/** `last_assistant_message` is model output on a bounded spool, so it is capped. */
const MAX_LAST_MESSAGE = 500;

export function noteSubagentStart(
  box: SubagentBox,
  input: { agent_id: string; agent_type: string },
  nowMs: number,
): AgentEvent {
  box.startedAt.set(input.agent_id, nowMs);
  return {
    type: 'agent.tool_call',
    payload: {
      phase: 'subagent_start',
      subagent_id: input.agent_id,
      subagent_type: input.agent_type,
    },
  };
}

/**
 * A stop with no recorded start still reports — a subagent already running
 * when this run took over, or a start hook that never fired, is exactly the
 * case where staying silent would hide the more useful of the two events. It
 * simply carries no duration rather than a fabricated one.
 */
export function noteSubagentStop(
  box: SubagentBox,
  input: { agent_id: string; agent_type: string; last_assistant_message?: string },
  nowMs: number,
): AgentEvent {
  const startedAt = box.startedAt.get(input.agent_id);
  box.startedAt.delete(input.agent_id);

  const last = input.last_assistant_message;

  return {
    type: 'agent.tool_call',
    payload: {
      phase: 'subagent_stop',
      subagent_id: input.agent_id,
      subagent_type: input.agent_type,
      ...(startedAt === undefined ? {} : { duration_ms: nowMs - startedAt }),
      ...(last === undefined ? {} : { last_message: last.slice(0, MAX_LAST_MESSAGE) }),
    },
  };
}
