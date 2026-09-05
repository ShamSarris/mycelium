import type { EventEnvelope } from '@mycelium/contracts';
import type { Clock } from '../clock.js';
import type { EmittedEvent, EventSink } from './sink.js';
import type { SeqCounters } from './seq.js';
import type { Spool } from './spool.js';

export interface SpoolSinkOptions {
  supervisorId: string;
  spool: Spool;
  seq: SeqCounters;
  clock: Clock;
  newId: () => string;
}

/**
 * Stamps identity onto everything this VM records and puts it on disk.
 *
 * The stamping is not a convenience: the plan agent emits through this same
 * sink over the RPC socket, so there is exactly one sequence counter per stream
 * on the VM. An agent that assigned its own numbers could not be restarted
 * without either reusing one or leaving a gap, and both are indistinguishable
 * from lost events at the orchestrator.
 */
export class SpoolEventSink implements EventSink {
  constructor(private readonly options: SpoolSinkOptions) {}

  streamIdFor(event: EmittedEvent): string {
    return event.source === 'agent'
      ? `agent:${event.planId ?? 'unknown'}`
      : `supervisor:${this.options.supervisorId}`;
  }

  async emit(event: EmittedEvent): Promise<void> {
    const { spool, seq, clock, newId } = this.options;
    const streamId = this.streamIdFor(event);

    const envelope = {
      event_id: newId(),
      ts: event.ts ?? clock.now().toISOString(),
      source: event.source,
      stream_id: streamId,
      seq: seq.next(streamId),
      type: event.type,
      severity: event.severity ?? 'info',
      project_id: event.projectId ?? null,
      plan_id: event.planId ?? null,
      task_id: event.taskId ?? null,
      payload: event.payload ?? {},
    } as EventEnvelope;

    const { dropped } = await spool.append(envelope);

    // The spool overflowed and threw history away. Say so in the log itself
    // rather than leaving an unexplained gap in the sequence, which reads like
    // lost events rather than a full disk.
    if (dropped !== null) {
      const marker = {
        event_id: newId(),
        ts: clock.now().toISOString(),
        source: 'supervisor',
        stream_id: `supervisor:${this.options.supervisorId}`,
        seq: seq.next(`supervisor:${this.options.supervisorId}`),
        type: 'error',
        severity: 'warn',
        project_id: null,
        plan_id: null,
        task_id: null,
        payload: {
          code: 'events_dropped',
          dropped_from_seq: dropped.from,
          dropped_to_seq: dropped.to,
          dropped_count: dropped.count,
        },
      } as EventEnvelope;
      await spool.append(marker);
    }
  }
}
