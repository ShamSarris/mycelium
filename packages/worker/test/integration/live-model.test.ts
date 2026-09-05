import { describe, expect, it } from 'vitest';
import { AnthropicTransport } from '../../src/transport/anthropic.js';
import type { ModelRequest } from '../../src/transport/transport.js';

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
