import Anthropic from '@anthropic-ai/sdk';
import {
  UsageUnavailable,
  type ContentBlock,
  type ModelRequest,
  type ModelResponse,
  type ModelTransport,
  type NormalizedUsage,
  type StopReason,
} from './transport.js';

/**
 * The only file in this package that imports a provider SDK.
 *
 * It streams and then takes the final message rather than calling `create`:
 * `max_tokens` here is 64k by default, and a non-streaming request that large
 * risks an HTTP timeout. It does not use the SDK's tool runner, because the
 * runner owns the loop and the host owning the loop is the entire point of
 * this seam.
 *
 * Nothing above this file knows any of the vocabulary below.
 */
export class AnthropicTransport implements ModelTransport {
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async send(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    const stream = this.client.messages.stream(
      {
        model: request.model,
        max_tokens: request.maxTokens,
        // Adaptive is the only on-mode on this model family, and it is on by
        // default here; `budget_tokens` is a 400. Depth is set by effort.
        thinking: { type: 'adaptive' },
        output_config: { effort: request.effort },
        // The system prompt and the tool list are byte-identical across every
        // turn of a task, so the breakpoint goes at the end of them and the
        // transcript that follows stays outside the cached prefix.
        system: [
          {
            type: 'text',
            text: request.system,
            cache_control: { type: 'ephemeral' },
          },
        ],
        tools: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema as Anthropic.Tool['input_schema'],
          // Asks the provider for schema-valid arguments. It does not replace
          // the host-side check, which exists because the model producing them
          // is assumed prompt-injectable.
          strict: true,
        })),
        messages: request.messages.map(toProviderMessage),
      },
      { signal },
    );

    const message = await stream.finalMessage();

    return {
      content: message.content.map(toHostBlock).filter((block): block is ContentBlock => block !== null),
      stopReason: toStopReason(message.stop_reason),
      ...(message.stop_reason === 'refusal'
        ? {
            refusal: {
              category: message.stop_details?.category ?? null,
              ...(message.stop_details?.explanation === undefined
                ? {}
                : { explanation: message.stop_details.explanation }),
            },
          }
        : {}),
      usage: toUsage(message.usage),
    };
  }
}

function toProviderMessage(message: {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}): Anthropic.MessageParam {
  return {
    role: message.role,
    content: message.content.map((block): Anthropic.ContentBlockParam => {
      switch (block.type) {
        case 'text':
          return { type: 'text', text: block.text };
        case 'thinking':
          // Echoed back unchanged when continuing on the same model.
          return { type: 'thinking', thinking: block.thinking, signature: '' };
        case 'tool_use':
          return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
        case 'tool_result':
          return {
            type: 'tool_result',
            tool_use_id: block.toolUseId,
            content: block.content,
            is_error: block.isError,
          };
      }
    }),
  };
}

function toHostBlock(block: Anthropic.ContentBlock): ContentBlock | null {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'thinking':
      return { type: 'thinking', thinking: block.thinking };
    case 'tool_use':
      // The SDK has already parsed this. Never string-match the serialised
      // form: escaping varies between models and between turns.
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: (block.input ?? {}) as Record<string, unknown>,
      };
    default:
      // Server-tool blocks and anything added later. Dropped rather than
      // guessed at; nothing above this file declares a server tool.
      return null;
  }
}

function toStopReason(reason: string | null): StopReason {
  switch (reason) {
    case 'tool_use':
    case 'max_tokens':
    case 'refusal':
      return reason;
    default:
      // `stop_sequence` and a natural finish are the same thing to the loop,
      // and `pause_turn` cannot arrive because no server tool is declared.
      return 'end_turn';
  }
}

function toUsage(usage: Anthropic.Usage | undefined): NormalizedUsage {
  // A transport that cannot say what a call cost cannot be trusted to enforce
  // a budget, and a zero here would be a ceiling that never arrives.
  if (
    usage === undefined ||
    usage === null ||
    typeof usage.input_tokens !== 'number' ||
    typeof usage.output_tokens !== 'number'
  ) {
    throw new UsageUnavailable('the provider returned no usage for this call');
  }

  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    source: 'provider',
  };
}
