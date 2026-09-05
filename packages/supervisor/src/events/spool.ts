import { createReadStream } from 'node:fs';
import { appendFile, mkdir, open, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { EventEnvelope } from '@mycelium/contracts';

export interface DroppedRange {
  from: number;
  to: number;
  count: number;
}

export interface AppendOutcome {
  /** Set when the cap forced the oldest records out, so the caller can record it. */
  dropped: DroppedRange | null;
}

/**
 * The supervisor's only durable state: an append-only JSONL file, fsynced, that
 * holds events until the orchestrator has them. Baseline section 10 promises
 * that an orchestrator outage costs nothing but latency, and this is what pays
 * for that promise.
 *
 * Delivery is bounded at-least-once and ordered per stream. Records leave only
 * when the orchestrator has accepted them, so a crash between the POST and the
 * commit replays rather than loses — the orchestrator deduplicates on event_id.
 */
export class Spool {
  private size = 0;

  constructor(
    private readonly file: string,
    private readonly maxBytes: number,
  ) {}

  get rejectedFile(): string {
    return `${this.file}.rejected`;
  }

  async open(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const handle = await open(this.file, 'a');
    await handle.close();
    this.size = (await stat(this.file)).size;
  }

  /**
   * One record per line. JSON.stringify escapes newlines inside the payload, so
   * a multi-line message cannot split a record in two.
   */
  async append(envelope: EventEnvelope): Promise<AppendOutcome> {
    const line = `${JSON.stringify(envelope)}\n`;
    const bytes = Buffer.byteLength(line);

    let dropped: DroppedRange | null = null;
    if (this.size + bytes > this.maxBytes) {
      dropped = await this.dropOldestFor(bytes);
    }

    const handle = await open(this.file, 'a');
    try {
      await handle.writeFile(line);
      // The whole point of the spool is surviving a crash, which an OS buffer
      // does not. Cheap at this volume.
      await handle.sync();
    } finally {
      await handle.close();
    }

    this.size += bytes;
    return { dropped };
  }

  /** The oldest `limit` records, without removing them. */
  async peek(limit: number): Promise<EventEnvelope[]> {
    const { records } = await this.readFront(limit);
    return records;
  }

  /** Drops the oldest `count` records: they are safely at the orchestrator. */
  async commit(count: number): Promise<void> {
    await this.removeFront(count, null);
  }

  /**
   * Drops the oldest `count` records into a sidecar file. Used for a batch the
   * orchestrator refused outright, which no amount of retrying will fix and
   * which would otherwise wedge the spool behind it.
   */
  async reject(count: number): Promise<void> {
    await this.removeFront(count, this.rejectedFile);
  }

  /** Per stream, the highest seq this file holds — half of seq recovery. */
  async highestSeqByStream(): Promise<Map<string, number>> {
    const marks = new Map<string, number>();
    for await (const record of this.records()) {
      const current = marks.get(record.stream_id);
      if (current === undefined || record.seq > current) marks.set(record.stream_id, record.seq);
    }
    return marks;
  }

  async close(): Promise<void> {
    // Nothing is held open between calls; each append opens, syncs, and closes.
  }

  private async *records(): AsyncGenerator<EventEnvelope> {
    const stream = createReadStream(this.file, { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (line.trim() === '') continue;
        yield JSON.parse(line) as EventEnvelope;
      }
    } finally {
      lines.close();
      stream.destroy();
    }
  }

  /** Reads the first `limit` records, and the raw lines they came from. */
  private async readFront(
    limit: number,
  ): Promise<{ records: EventEnvelope[]; lines: string[] }> {
    const records: EventEnvelope[] = [];
    const lines: string[] = [];

    const stream = createReadStream(this.file, { encoding: 'utf8' });
    const reader = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of reader) {
        if (records.length >= limit) break;
        if (line.trim() === '') continue;
        records.push(JSON.parse(line) as EventEnvelope);
        lines.push(line);
      }
    } finally {
      reader.close();
      stream.destroy();
    }

    return { records, lines };
  }

  /**
   * Rewrites the file without its first `count` records, optionally appending
   * them to a sidecar first. Rewrite-and-rename rather than an in-place shift,
   * so a crash mid-truncate leaves the original intact.
   */
  private async removeFront(count: number, moveTo: string | null): Promise<void> {
    if (count <= 0) return;

    const { lines } = await this.readFront(count);
    if (lines.length === 0) return;

    if (moveTo !== null) {
      await appendFile(moveTo, `${lines.join('\n')}\n`);
    }

    const remainder: string[] = [];
    let index = 0;
    for await (const record of this.records()) {
      index += 1;
      if (index <= lines.length) continue;
      remainder.push(JSON.stringify(record));
    }

    const contents = remainder.length === 0 ? '' : `${remainder.join('\n')}\n`;
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, contents);
    await rename(temporary, this.file);
    this.size = Buffer.byteLength(contents);
  }

  /**
   * Overflow policy: drop oldest. Losing the newest would hide whatever is
   * currently going wrong, which is the opposite of what an event log is for.
   */
  private async dropOldestFor(incoming: number): Promise<DroppedRange | null> {
    const all: EventEnvelope[] = [];
    for await (const record of this.records()) all.push(record);
    if (all.length === 0) return null;

    let dropCount = 0;
    let freed = 0;
    while (dropCount < all.length && this.size - freed + incoming > this.maxBytes) {
      const record = all[dropCount];
      if (record === undefined) break;
      freed += Buffer.byteLength(`${JSON.stringify(record)}\n`);
      dropCount += 1;
    }
    if (dropCount === 0) return null;

    const first = all[0];
    const last = all[dropCount - 1];
    await this.removeFront(dropCount, null);

    return {
      from: first?.seq ?? 0,
      to: last?.seq ?? 0,
      count: dropCount,
    };
  }
}
