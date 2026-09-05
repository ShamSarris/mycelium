import type { ContentBlock, Message } from '../transport/transport.js';

/**
 * The canonical conversation. This side owns it (archive T16): every request
 * is rebuilt from here, and the provider is never asked to remember a turn.
 * A provider session that was authoritative would put the budget, the audit
 * trail, and the resumption story somewhere this process cannot see.
 */
export class Conversation {
  private readonly messages: Message[] = [];

  constructor(opening: string) {
    this.messages.push({ role: 'user', content: [{ type: 'text', text: opening }] });
  }

  /** A copy, so nothing downstream can rewrite history by holding the array. */
  snapshot(): Message[] {
    return this.messages.map((message) => ({ ...message, content: [...message.content] }));
  }

  appendAssistant(content: ContentBlock[]): void {
    this.messages.push({ role: 'assistant', content: [...content] });
  }

  appendUserText(text: string): void {
    this.messages.push({ role: 'user', content: [{ type: 'text', text }] });
  }

  /**
   * Every tool result from one assistant turn, in one user message. Splitting
   * them across messages silently teaches the model to stop calling tools in
   * parallel.
   */
  appendToolResults(results: ContentBlock[]): void {
    this.messages.push({ role: 'user', content: [...results] });
  }

  get length(): number {
    return this.messages.length;
  }
}
