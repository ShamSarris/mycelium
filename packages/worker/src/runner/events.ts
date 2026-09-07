import type { AgentEvent } from '../broker.js';
import { attribution, type SubagentBox } from './subagents.js';

/**
 * The pure event mapper (ticket 11 §6.1): `(sdkMessage, state) => AgentEvent[]`.
 *
 * Deliberately structural rather than typed against the real Agent SDK's
 * message union: this file must never import the Agent SDK package —
 * `runner/agent-sdk.ts` is the only file this ticket set permits to do that
 * (ticket 11 §3; ticket 14 adds the guard test). A real SDK message value
 * satisfies `MapperMessage` structurally (it always has more fields than this
 * needs, never fewer of the ones read here), so `agent-sdk.ts` hands this
 * function messages straight off the SDK's async iterator (with a narrowing
 * cast, since the SDK's own message union is too large for TypeScript to
 * check structural assignability against cleanly), and a test can hand it a
 * hand-written object literal with no SDK dependency at all — which is what
 * makes this the one part of the runner cheaply testable without a live
 * model call, a subprocess, or an API key.
 *
 * `taskId` is deliberately absent from every returned event: this function
 * does not know which task it is mapping for, only `agent-sdk.ts` does, and
 * it attaches `taskId` when it forwards these to `deps.broker.emit`.
 */

export interface MapperUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/** Loose enough to cover text, thinking, tool_use, and tool_result blocks alike. */
export interface MapperContentBlock {
  type: string;
  id?: string;
  name?: string;
  tool_use_id?: string;
  is_error?: boolean;
}

export interface MapperMessage {
  type: string;
  subtype?: string;
  message?: {
    model?: string;
    stop_reason?: string | null;
    usage?: MapperUsage;
    content?: MapperContentBlock[] | string;
  };
  compact_metadata?: {
    trigger: 'manual' | 'auto';
    pre_tokens: number;
    post_tokens?: number;
  };
}

export interface MapperState {
  /** `dispatch.cost_spent_so_far_microusd` — what earlier execution attempts already used. */
  readonly priorSpendMicrousd: number;
  attemptInputTokens: number;
  attemptOutputTokens: number;
  attemptCacheReadTokens: number;
  attemptCacheWriteTokens: number;
  /** tool_use id -> tool name, so the matching tool_result can name the tool it answers. */
  pendingToolNames: Record<string, string>;
}

export function initialMapperState(priorSpendMicrousd = 0): MapperState {
  return {
    priorSpendMicrousd,
    attemptInputTokens: 0,
    attemptOutputTokens: 0,
    attemptCacheReadTokens: 0,
    attemptCacheWriteTokens: 0,
    pendingToolNames: {},
  };
}

function attemptTotal(state: MapperState): number {
  return (
    state.attemptInputTokens +
    state.attemptOutputTokens +
    state.attemptCacheReadTokens +
    state.attemptCacheWriteTokens
  );
}

/** Task-wide across execution attempts, never a delta: see `agent.model_call` in §6.1. */
export function cumulativeTokens(state: MapperState): number {
  return state.priorSpendMicrousd + attemptTotal(state);
}

const LIMIT_BY_RESULT_SUBTYPE: Record<string, string> = {
  error_max_budget_usd: 'task_cost',
  error_max_turns: 'max_turns',
};

/**
 * `subagents` is optional because attribution is: a caller with no box gets
 * exactly the events this mapper produced before subagent tracking existed.
 * See `runner/subagents.ts` for why the join key is `tool_use_id`.
 */
export function mapSdkMessage(
  message: MapperMessage,
  state: MapperState,
  subagents?: SubagentBox,
): AgentEvent[] {
  if (message.type === 'assistant' && message.message?.usage !== undefined) {
    return mapAssistant(message.message, state);
  }

  if (message.type === 'result' && message.subtype !== undefined) {
    return mapResult(message.subtype);
  }

  if (
    message.type === 'system' &&
    message.subtype === 'compact_boundary' &&
    message.compact_metadata !== undefined
  ) {
    return mapCompactBoundary(message.compact_metadata);
  }

  if (message.type === 'user' && Array.isArray(message.message?.content)) {
    return mapToolResults(message.message.content, state, subagents);
  }

  return [];
}

function mapAssistant(
  message: NonNullable<MapperMessage['message']>,
  state: MapperState,
): AgentEvent[] {
  const usage = message.usage as MapperUsage;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;

  state.attemptInputTokens += usage.input_tokens;
  state.attemptOutputTokens += usage.output_tokens;
  state.attemptCacheReadTokens += cacheRead;
  state.attemptCacheWriteTokens += cacheWrite;

  const content = Array.isArray(message.content) ? message.content : [];
  for (const block of content) {
    if (block.type === 'tool_use' && block.id !== undefined && block.name !== undefined) {
      state.pendingToolNames[block.id] = block.name;
    }
  }

  const tokensTotal = cumulativeTokens(state);
  const tokensThisAttempt = attemptTotal(state);

  return [
    {
      type: 'agent.model_call',
      payload: {
        model: message.model ?? 'unknown',
        stop_reason: message.stop_reason ?? null,
        // Task-wide cumulative, never a delta: a dropped event on a bounded
        // spool must not lose spend, and a retry must not reset the total —
        // the same rule `loop/run.ts` applied to the host loop.
        tokens_total: tokensTotal,
        tokens_this_attempt: tokensThisAttempt,
        // Mirrors the token totals for now, exactly as the host loop did:
        // the SDK's own per-call `usage` on an `assistant` message carries no
        // cost, only `modelUsage` on the terminal `result` message does, and
        // in single-prompt mode that arrives once, at the very end. The
        // authoritative cost lands in `TaskOutcome.costMicrousd`, computed
        // from `modelUsage` once the run ends — see `runner/agent-sdk.ts`.
        cost_total_microusd: tokensTotal,
        cost_this_attempt_microusd: tokensThisAttempt,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_read_tokens: cacheRead,
        cache_write_tokens: cacheWrite,
        usage_source: 'provider',
      },
    },
  ];
}

function mapResult(subtype: string): AgentEvent[] {
  const limit = LIMIT_BY_RESULT_SUBTYPE[subtype];
  if (limit === undefined) return [];
  return [{ type: 'limit.exceeded', severity: 'warn', payload: { limit } }];
}

function mapCompactBoundary(metadata: {
  trigger: 'manual' | 'auto';
  pre_tokens: number;
  post_tokens?: number;
}): AgentEvent[] {
  // §9: the event schema's type enum is closed with no dedicated compaction
  // type, so this rides `agent.model_call` with `phase: 'compaction'` — the
  // plan's own recommendation, since `payload` is untyped in v1.
  return [
    {
      type: 'agent.model_call',
      payload: {
        phase: 'compaction',
        trigger: metadata.trigger,
        pre_tokens: metadata.pre_tokens,
        ...(metadata.post_tokens === undefined ? {} : { post_tokens: metadata.post_tokens }),
      },
    },
  ];
}

function mapToolResults(
  content: MapperContentBlock[],
  state: MapperState,
  subagents?: SubagentBox,
): AgentEvent[] {
  const events: AgentEvent[] = [];

  for (const block of content) {
    if (block.type !== 'tool_result' || block.tool_use_id === undefined) continue;

    const isError = block.is_error === true;
    const tool = state.pendingToolNames[block.tool_use_id] ?? 'unknown';
    // Absent for a main-thread call, and left absent rather than filled with
    // a placeholder: "no subagent" and "some subagent we could not name" are
    // different facts, and the dashboard groups on this key.
    const by = subagents === undefined ? null : attribution(subagents, block.tool_use_id);

    events.push({
      type: 'agent.tool_call',
      severity: isError ? 'warn' : 'info',
      payload: { tool, outcome: 'result', is_error: isError, ...(by ?? {}) },
    });
  }

  return events;
}
