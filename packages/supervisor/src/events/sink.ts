import type { EventEnvelope } from '@mycelium/contracts';

/**
 * How every part of the supervisor records something. The envelope's identity
 * fields are stamped here rather than by the caller: `event_id`, `stream_id`,
 * and above all `seq`, which must be monotonic per stream for ordered replay to
 * mean anything. The plan agent hands over the same shape over the RPC socket
 * and gets its sequence numbers from here too, so there is exactly one counter
 * per stream on this VM.
 */
export interface EmittedEvent {
  type: EventEnvelope['type'];
  severity?: 'debug' | 'info' | 'warn' | 'error';
  /** `supervisor` for this daemon's own records, `agent` for a relayed one. */
  source: 'supervisor' | 'agent';
  planId?: string | null;
  projectId?: string | null;
  taskId?: string | null;
  payload?: Record<string, unknown>;
  /** The emitter's wall clock. Defaults to the injected clock. */
  ts?: string;
}

export interface EventSink {
  emit(event: EmittedEvent): Promise<void>;
}
