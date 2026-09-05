import type { ModelEffort } from '../config.js';

/**
 * The provider seam (archive T16). This file imports no SDK, and neither does
 * anything above it: the host owns the agent loop and canonical conversation
 * state, and constructs every request from that state. A provider session is
 * never authoritative, which is what makes the whole package testable against
 * a scripted fake and what would make a second provider a drop-in.
 */
export interface ModelTransport {
  send(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse>;
}

export interface ModelRequest {
  model: string;
  /** Stable across every turn of a task, so it can carry the cache breakpoint. */
  system: string;
  messages: Message[];
  tools: ToolDeclaration[];
  maxTokens: number;
  effort: ModelEffort;
}

export interface ModelResponse {
  content: ContentBlock[];
  stopReason: StopReason;
  /** Present only when `stopReason` is `refusal`. */
  refusal?: Refusal;
  usage: NormalizedUsage;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal';

export interface Refusal {
  /** An open set — `cyber`, `bio`, and others, or null. Reported, never matched on. */
  category: string | null;
  /** Null when the provider gave a category but no prose, which it may. */
  explanation?: string | null;
}

export interface Message {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; content: string; isError: boolean };

export interface ToolDeclaration {
  name: string;
  description: string;
  /** JSON Schema. `additionalProperties: false` and `required` are not optional here. */
  inputSchema: Record<string, unknown>;
}

/**
 * Every budget decision is computed from this and only this. Never from an
 * SDK-internal counter, and never from anything the model said about its own
 * usage.
 */
export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /**
   * `provider` when the API reported it. A transport that cannot produce usage
   * throws rather than returning zeros — a silent zero is a budget that never
   * runs out.
   */
  source: 'provider' | 'estimated';
}

/** The transport could not produce usage, so no budget decision can be trusted. */
export class UsageUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageUnavailable';
  }
}
