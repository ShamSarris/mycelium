/**
 * Sequence numbers are monotonic per stream and are the only thing that makes
 * ordered replay meaningful: the orchestrator deduplicates on `event_id`, but
 * it refuses a `(stream_id, seq)` pair reused for a different event, treating
 * it as the emitter bug it is.
 *
 * The hazard this guards is specific. The spool truncates records once the
 * orchestrator has them, so after a restart the local file no longer proves how
 * far the counter got. Recovery therefore takes the higher of what the spool
 * still holds and what the orchestrator says it stored, and until that has
 * happened this refuses to issue anything at all.
 */
export class SeqCounters {
  private readonly counters = new Map<string, number>();
  private recovered = false;

  get isRecovered(): boolean {
    return this.recovered;
  }

  recover(...sources: Array<Map<string, number> | Array<{ stream_id: string; seq: number }>>): void {
    for (const source of sources) {
      const entries: Array<[string, number]> = Array.isArray(source)
        ? source.map((mark) => [mark.stream_id, mark.seq])
        : [...source.entries()];

      for (const [streamId, seq] of entries) {
        const current = this.counters.get(streamId);
        if (current === undefined || seq > current) this.counters.set(streamId, seq);
      }
    }
    this.recovered = true;
  }

  next(streamId: string): number {
    if (!this.recovered) {
      throw new Error(
        'refusing to assign a sequence number before reconciliation: a truncated spool cannot prove how far this stream got',
      );
    }
    const next = (this.counters.get(streamId) ?? -1) + 1;
    this.counters.set(streamId, next);
    return next;
  }
}
