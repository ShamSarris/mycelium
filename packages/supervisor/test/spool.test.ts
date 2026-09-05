import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { EventEnvelope } from '@mycelium/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Spool } from '../src/events/spool.js';

let dir: string;
let spool: Spool;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'mycelium-spool-'));
  spool = new Spool(path.join(dir, 'events.jsonl'), 1024 * 1024);
  await spool.open();
});

afterEach(async () => {
  await spool.close();
  await rm(dir, { recursive: true, force: true });
});

let counter = 0;

function envelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  counter += 1;
  return {
    event_id: `018f3a5c-0000-7000-8000-${String(counter).padStart(12, '0')}`,
    ts: '2026-09-02T12:00:00.000Z',
    source: 'supervisor',
    stream_id: 'supervisor:node-1',
    seq: counter,
    type: 'supervisor.heartbeat',
    ...overrides,
  } as EventEnvelope;
}

describe('Spool - append and peek', () => {
  it('returns nothing from an empty spool', async () => {
    expect(await spool.peek(10)).toEqual([]);
  });

  it('returns records in the order they were appended', async () => {
    const first = envelope();
    const second = envelope();
    await spool.append(first);
    await spool.append(second);

    const peeked = await spool.peek(10);
    expect(peeked.map((e) => e.event_id)).toEqual([first.event_id, second.event_id]);
  });

  it('never returns more than the limit', async () => {
    for (let i = 0; i < 5; i += 1) await spool.append(envelope());
    expect(await spool.peek(2)).toHaveLength(2);
  });

  it('survives a payload containing a newline, which would otherwise split a record', async () => {
    await spool.append(envelope({ payload: { message: 'line one\nline two' } }));
    const [record] = await spool.peek(10);
    expect((record?.payload as { message: string }).message).toBe('line one\nline two');
  });
});

describe('Spool - commit', () => {
  it('drops only the records that were delivered', async () => {
    const kept: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const event = envelope();
      if (i >= 2) kept.push(event.event_id);
      await spool.append(event);
    }

    await spool.commit(2);
    expect((await spool.peek(10)).map((e) => e.event_id)).toEqual(kept);
  });

  it('empties the file when everything is committed', async () => {
    await spool.append(envelope());
    await spool.commit(1);

    expect(await spool.peek(10)).toEqual([]);
    expect((await stat(path.join(dir, 'events.jsonl'))).size).toBe(0);
  });

  it('survives a reopen, so a restart does not replay what was delivered', async () => {
    await spool.append(envelope());
    const survivor = envelope();
    await spool.append(survivor);
    await spool.commit(1);
    await spool.close();

    const reopened = new Spool(path.join(dir, 'events.jsonl'), 1024 * 1024);
    await reopened.open();
    expect((await reopened.peek(10)).map((e) => e.event_id)).toEqual([survivor.event_id]);
    await reopened.close();
  });

  it('appends correctly after a commit', async () => {
    await spool.append(envelope());
    await spool.commit(1);
    const next = envelope();
    await spool.append(next);

    expect((await spool.peek(10)).map((e) => e.event_id)).toEqual([next.event_id]);
  });
});

describe('Spool - reject', () => {
  // A 4xx is an emitter bug, not a transient. Retrying spins forever on the
  // same record, so the batch is set aside and the spool keeps draining.
  it('moves the batch aside and lets the rest of the spool drain', async () => {
    const bad = envelope();
    const good = envelope();
    await spool.append(bad);
    await spool.append(good);

    await spool.reject(1);

    expect((await spool.peek(10)).map((e) => e.event_id)).toEqual([good.event_id]);
    const rejected = await readFile(path.join(dir, 'events.jsonl.rejected'), 'utf8');
    expect(rejected).toContain(bad.event_id);
  });
});

describe('Spool - the size cap', () => {
  it('reports what it dropped when appending would exceed the cap', async () => {
    const tiny = new Spool(path.join(dir, 'tiny.jsonl'), 600);
    await tiny.open();

    const dropped: Array<{ from: number; to: number; count: number }> = [];
    for (let i = 0; i < 8; i += 1) {
      const outcome = await tiny.append(envelope());
      if (outcome.dropped !== null) dropped.push(outcome.dropped);
    }

    expect(dropped.length).toBeGreaterThan(0);
    expect(dropped[0]?.count).toBeGreaterThan(0);
    expect(dropped[0]?.from).toBeLessThanOrEqual(dropped[0]?.to ?? 0);
    expect((await stat(path.join(dir, 'tiny.jsonl'))).size).toBeLessThanOrEqual(600);

    await tiny.close();
  });

  it('drops the oldest records, keeping the newest', async () => {
    const tiny = new Spool(path.join(dir, 'tiny2.jsonl'), 600);
    await tiny.open();

    const ids: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      const event = envelope();
      ids.push(event.event_id);
      await tiny.append(event);
    }

    const remaining = (await tiny.peek(100)).map((e) => e.event_id);
    expect(remaining.at(-1)).toBe(ids.at(-1));
    expect(remaining).not.toContain(ids[0]);

    await tiny.close();
  });
});

describe('Spool - seq recovery', () => {
  it('reports the highest seq it holds per stream', async () => {
    await spool.append(envelope({ stream_id: 'supervisor:node-1', seq: 4 }));
    await spool.append(envelope({ stream_id: 'supervisor:node-1', seq: 9 }));
    await spool.append(envelope({ stream_id: 'agent:plan-a', seq: 2 }));

    const marks = await spool.highestSeqByStream();
    expect(marks.get('supervisor:node-1')).toBe(9);
    expect(marks.get('agent:plan-a')).toBe(2);
  });

  it('reads the marks back after a reopen', async () => {
    await spool.append(envelope({ stream_id: 'supervisor:node-1', seq: 7 }));
    await spool.close();

    const reopened = new Spool(path.join(dir, 'events.jsonl'), 1024 * 1024);
    await reopened.open();
    expect((await reopened.highestSeqByStream()).get('supervisor:node-1')).toBe(7);
    await reopened.close();
  });
});
