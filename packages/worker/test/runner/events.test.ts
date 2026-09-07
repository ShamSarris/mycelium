import { looksLikeSecretKey } from '@mycelium/contracts';
import { describe, expect, it } from 'vitest';
import {
  cumulativeTokens,
  initialMapperState,
  mapSdkMessage,
  type MapperMessage,
  type MapperState,
} from '../../src/runner/events.js';

/**
 * The pure event mapper (ticket 11 §6.1): `(sdkMessage, state) => AgentEvent[]`.
 * Every message here is a hand-written object literal shaped like the real
 * Agent SDK's message types (confirmed against the installed
 * `@anthropic-ai/claude-agent-sdk@0.3.263` `sdk.d.ts` — `SDKAssistantMessage`,
 * `SDKResultMessage`, `SDKCompactBoundaryMessage`, `SDKUserMessage`) — no SDK
 * import, no subprocess, no network, no API key. That is what makes this
 * file able to run at all without the live model access `01-findings.md`
 * says this session cannot obtain.
 */

function assistantMessage(overrides: Partial<MapperMessage['message']> = {}): MapperMessage {
  return {
    type: 'assistant',
    message: {
      model: 'claude-sonnet-5',
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 50 },
      content: [],
      ...overrides,
    },
  };
}

describe('mapSdkMessage', () => {
  it('maps an assistant message with usage to agent.model_call, cumulative and task-wide', () => {
    const state = initialMapperState();

    const events = mapSdkMessage(assistantMessage(), state);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'agent.model_call',
      payload: {
        model: 'claude-sonnet-5',
        stop_reason: 'tool_use',
        tokens_total: 150,
        tokens_this_attempt: 150,
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        usage_source: 'provider',
      },
    });
  });

  it('never emits tokens_total as a delta: three turns accumulate task-wide, not per-call', () => {
    const state = initialMapperState();

    const first = mapSdkMessage(assistantMessage({ usage: { input_tokens: 100, output_tokens: 50 } }), state);
    const second = mapSdkMessage(assistantMessage({ usage: { input_tokens: 20, output_tokens: 10 } }), state);
    const third = mapSdkMessage(assistantMessage({ usage: { input_tokens: 5, output_tokens: 5 } }), state);

    expect(first[0]?.payload?.tokens_total).toBe(150);
    expect(second[0]?.payload?.tokens_total).toBe(180);
    expect(third[0]?.payload?.tokens_total).toBe(190);
    expect(cumulativeTokens(state)).toBe(190);
  });

  it('seeds cumulative tokens from prior execution attempts, task-wide across attempts', () => {
    const state = initialMapperState(1_000);

    const events = mapSdkMessage(assistantMessage(), state);

    // priorSpend (1000) + this attempt's 150.
    expect(events[0]?.payload?.tokens_total).toBe(1150);
  });

  it('carries a cumulative cost figure alongside the cumulative tokens', () => {
    const state = initialMapperState();
    const events = mapSdkMessage(assistantMessage(), state);
    expect(typeof events[0]?.payload?.cost_total_microusd).toBe('number');
    expect(events[0]?.payload?.cost_total_microusd).toBeGreaterThan(0);
  });

  it('maps a result message with subtype error_max_budget_usd to limit.exceeded, limit task_cost', () => {
    const state = initialMapperState();

    const events = mapSdkMessage({ type: 'result', subtype: 'error_max_budget_usd' }, state);

    expect(events).toEqual([
      { type: 'limit.exceeded', severity: 'warn', payload: { limit: 'task_cost' } },
    ]);
  });

  it('maps a result message with subtype error_max_turns to limit.exceeded, limit max_turns', () => {
    const state = initialMapperState();

    const events = mapSdkMessage({ type: 'result', subtype: 'error_max_turns' }, state);

    expect(events).toEqual([
      { type: 'limit.exceeded', severity: 'warn', payload: { limit: 'max_turns' } },
    ]);
  });

  it('emits nothing for a successful result message', () => {
    const state = initialMapperState();
    expect(mapSdkMessage({ type: 'result', subtype: 'success' }, state)).toEqual([]);
  });

  it('maps a compact_boundary system message to agent.model_call, phase compaction', () => {
    const state = initialMapperState();

    const events = mapSdkMessage(
      {
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'auto', pre_tokens: 180_000, post_tokens: 4_000 },
      },
      state,
    );

    expect(events).toEqual([
      {
        type: 'agent.model_call',
        payload: {
          phase: 'compaction',
          trigger: 'auto',
          pre_tokens: 180_000,
          post_tokens: 4_000,
        },
      },
    ]);
  });

  it('omits post_tokens on a compact_boundary message that has not finished yet', () => {
    const state = initialMapperState();

    const events = mapSdkMessage(
      {
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'manual', pre_tokens: 50_000 },
      },
      state,
    );

    expect(events[0]?.payload).not.toHaveProperty('post_tokens');
  });

  it('maps a tool_result carrying is_error to agent.tool_call, is_error true, severity warn', () => {
    const state = initialMapperState();

    // The tool's name is only known from the tool_use block that requested
    // it; a real session always sees that assistant message first.
    mapSdkMessage(
      assistantMessage({
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'sandbox' }],
      }),
      state,
    );

    const events = mapSdkMessage(
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: true }] },
      },
      state,
    );

    expect(events).toEqual([
      {
        type: 'agent.tool_call',
        severity: 'warn',
        payload: { tool: 'sandbox', outcome: 'result', is_error: true },
      },
    ]);
  });

  it('maps a successful tool_result to agent.tool_call, is_error false, severity info', () => {
    const state = initialMapperState();

    mapSdkMessage(
      assistantMessage({
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: 'tool_use', id: 'toolu_2', name: 'git' }],
      }),
      state,
    );

    const events = mapSdkMessage(
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_2' }] },
      },
      state,
    );

    expect(events).toEqual([
      {
        type: 'agent.tool_call',
        severity: 'info',
        payload: { tool: 'git', outcome: 'result', is_error: false },
      },
    ]);
  });

  it('names the tool unknown when the matching tool_use was never seen', () => {
    const state = initialMapperState();

    const events = mapSdkMessage(
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_missing', is_error: true }] },
      },
      state,
    );

    expect(events[0]?.payload?.tool).toBe('unknown');
  });

  it('ignores a plain-text user message', () => {
    const state = initialMapperState();
    expect(mapSdkMessage({ type: 'user', message: { content: 'plain text' } }, state)).toEqual([]);
  });

  it('emits nothing for a message type this task does not care about', () => {
    const state = initialMapperState();
    expect(mapSdkMessage({ type: 'stream_event' }, state)).toEqual([]);
  });

  it('never produces a payload key that looksLikeSecretKey would flag', () => {
    const state = initialMapperState();

    mapSdkMessage(
      assistantMessage({
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 2,
          cache_creation_input_tokens: 1,
        },
        content: [{ type: 'tool_use', id: 'toolu_3', name: 'sandbox' }],
      }),
      state,
    );

    const allEvents = [
      ...mapSdkMessage(assistantMessage(), state),
      ...mapSdkMessage({ type: 'result', subtype: 'error_max_budget_usd' }, state),
      ...mapSdkMessage({ type: 'result', subtype: 'error_max_turns' }, state),
      ...mapSdkMessage(
        {
          type: 'system',
          subtype: 'compact_boundary',
          compact_metadata: { trigger: 'auto', pre_tokens: 1, post_tokens: 2 },
        },
        state,
      ),
      ...mapSdkMessage(
        {
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_3', is_error: true }] },
        },
        state,
      ),
    ];

    for (const event of allEvents) {
      for (const key of Object.keys(event.payload ?? {})) {
        expect(looksLikeSecretKey(key)).toBe(false);
      }
    }
  });
});
