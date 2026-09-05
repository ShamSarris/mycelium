import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from 'undici';
import { AnthropicTransport } from '../src/transport/anthropic.js';
import { UsageUnavailable, type ModelRequest } from '../src/transport/transport.js';

/**
 * The only file in the package that imports a provider SDK, and the only place
 * a provider's vocabulary appears. Everything above it speaks the normalized
 * shapes, which is what makes the rest of the suite runnable with no network
 * and what would make a second provider a drop-in rather than a rewrite.
 */

const ORIGIN = 'https://api.anthropic.com';

let agent: MockAgent;
let original: Dispatcher;

beforeEach(() => {
  original = getGlobalDispatcher();
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
});

afterEach(async () => {
  setGlobalDispatcher(original);
  await agent.close();
});

/** The wire format the SDK reads back: named SSE events, one JSON body each. */
function sse(events: Array<[string, unknown]>): string {
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

interface StreamOptions {
  blocks?: Array<Record<string, unknown>>;
  stopReason?: string;
  stopDetails?: Record<string, unknown> | null;
  startUsage?: Record<string, unknown> | null;
  deltaUsage?: Record<string, unknown>;
}

function stream(options: StreamOptions = {}): string {
  const blocks = options.blocks ?? [{ type: 'text', text: 'hello' }];

  const events: Array<[string, unknown]> = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          ...(options.startUsage === null
            ? {}
            : {
                usage: options.startUsage ?? {
                  input_tokens: 100,
                  output_tokens: 0,
                  cache_read_input_tokens: 20,
                  cache_creation_input_tokens: 5,
                },
              }),
        },
      },
    ],
  ];

  blocks.forEach((block, index) => {
    if (block.type === 'tool_use') {
      events.push([
        'content_block_start',
        {
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
        },
      ]);
      events.push([
        'content_block_delta',
        {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
        },
      ]);
    } else {
      events.push([
        'content_block_start',
        { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
      ]);
      events.push([
        'content_block_delta',
        { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } },
      ]);
    }
    events.push(['content_block_stop', { type: 'content_block_stop', index }]);
  });

  events.push([
    'message_delta',
    {
      type: 'message_delta',
      delta: {
        stop_reason: options.stopReason ?? 'end_turn',
        stop_sequence: null,
        ...(options.stopDetails === undefined ? {} : { stop_details: options.stopDetails }),
      },
      usage: options.deltaUsage ?? { output_tokens: 50 },
    },
  ]);
  events.push(['message_stop', { type: 'message_stop' }]);

  return sse(events);
}

function intercept(body: string, capture?: (payload: Record<string, unknown>) => void): void {
  agent
    .get(ORIGIN)
    .intercept({ path: '/v1/messages', method: 'POST' })
    .reply(
      200,
      (options) => {
        capture?.(JSON.parse(String(options.body)) as Record<string, unknown>);
        return body;
      },
      { headers: { 'content-type': 'text/event-stream' } },
    );
}

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: 'claude-opus-5',
    system: 'you are a plan agent',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'do the thing' }] }],
    tools: [
      {
        name: 'read_file',
        description: 'read a file',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['path'],
          properties: { path: { type: 'string' } },
        },
      },
    ],
    maxTokens: 64_000,
    effort: 'high',
    ...overrides,
  };
}

function transport(): AnthropicTransport {
  return new AnthropicTransport('sk-ant-test');
}

describe('the request it builds', () => {
  it('asks for adaptive thinking and the effort the host chose', async () => {
    let sent: Record<string, unknown> | null = null;
    intercept(stream(), (payload) => {
      sent = payload;
    });

    await transport().send(request(), new AbortController().signal);

    // budget_tokens is a 400 on this model; adaptive is the only on-mode, and
    // depth is set through effort instead.
    expect(sent!.thinking).toEqual({ type: 'adaptive' });
    expect(sent!.output_config).toEqual({ effort: 'high' });
    expect(sent!).not.toHaveProperty('budget_tokens');
  });

  it('puts the cache breakpoint on the stable prefix', async () => {
    let sent: Record<string, unknown> | null = null;
    intercept(stream(), (payload) => {
      sent = payload;
    });

    await transport().send(request(), new AbortController().signal);

    // The system prompt and the tool list are identical on every turn of a
    // task; the transcript after them is not.
    const system = sent!.system as Array<Record<string, unknown>>;
    expect(system.at(-1)?.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('declares tools strictly, so the provider constrains arguments too', async () => {
    let sent: Record<string, unknown> | null = null;
    intercept(stream(), (payload) => {
      sent = payload;
    });

    await transport().send(request(), new AbortController().signal);

    const tools = sent!.tools as Array<Record<string, unknown>>;
    expect(tools[0]).toMatchObject({ name: 'read_file', strict: true });
    expect((tools[0]!.input_schema as Record<string, unknown>).additionalProperties).toBe(false);
  });

  it('translates a tool result back into the provider is vocabulary', async () => {
    let sent: Record<string, unknown> | null = null;
    intercept(stream(), (payload) => {
      sent = payload;
    });

    await transport().send(
      request({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'go' }] },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tu-1', name: 'read_file', input: { path: 'a.ts' } }],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', toolUseId: 'tu-1', content: 'contents', isError: false },
            ],
          },
        ],
      }),
      new AbortController().signal,
    );

    const messages = sent!.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(messages[2]!.content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'tu-1',
      content: 'contents',
      is_error: false,
    });
  });
});

describe('the response it normalizes', () => {
  it('maps provider usage onto NormalizedUsage', async () => {
    intercept(stream());

    const response = await transport().send(request(), new AbortController().signal);

    expect(response.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 20,
      cacheWriteTokens: 5,
      source: 'provider',
    });
  });

  it('throws rather than reporting zero when usage arrives without counts', async () => {
    // The SDK's own accumulator requires a usage object on message_start, so
    // the reachable failure is a usage object that carries no counts.
    intercept(stream({ startUsage: { output_tokens: 0 }, deltaUsage: {} }));

    // A silent zero is a budget that never runs out.
    await expect(transport().send(request(), new AbortController().signal)).rejects.toBeInstanceOf(
      UsageUnavailable,
    );
  });

  it('normalizes text and stop reason', async () => {
    intercept(stream({ blocks: [{ type: 'text', text: 'on it' }] }));

    const response = await transport().send(request(), new AbortController().signal);

    expect(response.stopReason).toBe('end_turn');
    expect(response.content).toEqual([{ type: 'text', text: 'on it' }]);
  });

  it('normalizes a tool call with its input already parsed', async () => {
    intercept(
      stream({
        blocks: [{ type: 'tool_use', id: 'tu-1', name: 'read_file', input: { path: 'src/a.ts' } }],
        stopReason: 'tool_use',
      }),
    );

    const response = await transport().send(request(), new AbortController().signal);

    expect(response.stopReason).toBe('tool_use');
    expect(response.content).toEqual([
      { type: 'tool_use', id: 'tu-1', name: 'read_file', input: { path: 'src/a.ts' } },
    ]);
  });

  it('reports a refusal with its category and reads no content', async () => {
    intercept(
      stream({
        blocks: [],
        stopReason: 'refusal',
        stopDetails: { type: 'refusal', category: 'cyber', explanation: 'no' },
      }),
    );

    const response = await transport().send(request(), new AbortController().signal);

    expect(response.stopReason).toBe('refusal');
    expect(response.refusal).toMatchObject({ category: 'cyber' });
    expect(response.content).toEqual([]);
  });

  it('reports max_tokens rather than treating a cut-off turn as finished', async () => {
    intercept(stream({ stopReason: 'max_tokens' }));

    const response = await transport().send(request(), new AbortController().signal);

    expect(response.stopReason).toBe('max_tokens');
  });
});

describe('the seam itself', () => {
  it('is the only file in the package that imports the provider SDK', async () => {
    const offenders: string[] = [];

    async function walk(dir: string): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.name.endsWith('.ts')) {
          const source = await readFile(full, 'utf8');
          if (source.includes('@anthropic-ai/sdk') && !full.endsWith('anthropic.ts')) {
            offenders.push(full);
          }
        }
      }
    }

    await walk(path.join(import.meta.dirname, '..', 'src'));

    // The seam is only worth having if it holds. This is the assertion that
    // keeps a convenient import from quietly dissolving it.
    expect(offenders).toEqual([]);
  });
});
