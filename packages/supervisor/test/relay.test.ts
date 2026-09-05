import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SeqCounters } from '../src/events/seq.js';
import { Spool } from '../src/events/spool.js';
import { SpoolEventSink } from '../src/events/spoolSink.js';
import { MAX_BATCH, relayOnce } from '../src/events/relay.js';
import { FakeOrchestratorClient, MutableClock } from './helpers/fakes.js';

let dir: string;
let spool: Spool;
let seq: SeqCounters;
let sink: SpoolEventSink;
let clock: MutableClock;
let orchestrator: FakeOrchestratorClient;
let ids = 0;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'mycelium-relay-'));
  spool = new Spool(path.join(dir, 'events.jsonl'), 1024 * 1024);
  await spool.open();
  seq = new SeqCounters();
  seq.recover();
  clock = new MutableClock();
  orchestrator = new FakeOrchestratorClient();
  ids = 0;
  sink = new SpoolEventSink({
    supervisorId: 'node-1',
    spool,
    seq,
    clock,
    newId: () => {
      ids += 1;
      return `018f3a5c-0000-7000-8000-${String(ids).padStart(12, '0')}`;
    },
  });
});

afterEach(async () => {
  await spool.close();
  await rm(dir, { recursive: true, force: true });
});

describe('SeqCounters', () => {
  it('refuses to issue a number before reconciliation has run', () => {
    const fresh = new SeqCounters();
    expect(() => fresh.next('supervisor:node-1')).toThrow(/reconciliation/);
  });

  it('starts a fresh stream at zero', () => {
    expect(seq.next('supervisor:node-1')).toBe(0);
    expect(seq.next('supervisor:node-1')).toBe(1);
  });

  it('keeps a counter per stream', () => {
    seq.next('supervisor:node-1');
    expect(seq.next('agent:plan-a')).toBe(0);
  });

  // The spool truncates what the orchestrator has, so neither source alone
  // knows how far a stream got.
  it('resumes above the higher of the spool and the orchestrator marks', () => {
    const recovered = new SeqCounters();
    recovered.recover(new Map([['supervisor:node-1', 4]]), [
      { stream_id: 'supervisor:node-1', seq: 11 },
    ]);
    expect(recovered.next('supervisor:node-1')).toBe(12);
  });

  it('takes the spool mark when it is the higher of the two', () => {
    const recovered = new SeqCounters();
    recovered.recover(new Map([['agent:plan-a', 30]]), [{ stream_id: 'agent:plan-a', seq: 7 }]);
    expect(recovered.next('agent:plan-a')).toBe(31);
  });
});

describe('SpoolEventSink', () => {
  it('stamps identity and a monotonic seq onto a supervisor event', async () => {
    await sink.emit({ source: 'supervisor', type: 'supervisor.heartbeat' });
    await sink.emit({ source: 'supervisor', type: 'supervisor.heartbeat' });

    const records = await spool.peek(10);
    expect(records.map((r) => r.seq)).toEqual([0, 1]);
    expect(records[0]?.stream_id).toBe('supervisor:node-1');
    expect(records[0]?.source).toBe('supervisor');
    expect(records[0]?.ts).toBe(clock.now().toISOString());
  });

  it('puts an agent event on its own plan-scoped stream', async () => {
    await sink.emit({ source: 'agent', type: 'agent.tool_call', planId: 'plan-a' });
    const [record] = await spool.peek(10);
    expect(record?.stream_id).toBe('agent:plan-a');
    expect(record?.source).toBe('agent');
    expect(record?.plan_id).toBe('plan-a');
  });

  it('keeps the agent and supervisor streams independently numbered', async () => {
    await sink.emit({ source: 'supervisor', type: 'supervisor.heartbeat' });
    await sink.emit({ source: 'agent', type: 'agent.tool_call', planId: 'plan-a' });

    const records = await spool.peek(10);
    expect(records.map((r) => r.seq)).toEqual([0, 0]);
  });

  it('never reuses a seq across concurrent emits', async () => {
    await Promise.all(
      Array.from({ length: 20 }, () =>
        sink.emit({ source: 'supervisor', type: 'supervisor.heartbeat' }),
      ),
    );

    const records = await spool.peek(100);
    const numbers = records.map((r) => r.seq).sort((a, b) => a - b);
    expect(new Set(numbers).size).toBe(20);
    expect(numbers).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it('keeps the emitter timestamp when one is supplied, as a relayed event carries', async () => {
    await sink.emit({
      source: 'agent',
      type: 'agent.tool_call',
      planId: 'plan-a',
      ts: '2026-09-02T11:59:00.000Z',
    });
    const [record] = await spool.peek(10);
    expect(record?.ts).toBe('2026-09-02T11:59:00.000Z');
  });

  it('records an explanatory marker when the cap forces a drop', async () => {
    const tiny = new Spool(path.join(dir, 'tiny.jsonl'), 700);
    await tiny.open();
    const tinySink = new SpoolEventSink({
      supervisorId: 'node-1',
      spool: tiny,
      seq,
      clock,
      newId: () => {
        ids += 1;
        return `018f3a5c-0000-7000-8000-${String(ids).padStart(12, '0')}`;
      },
    });

    for (let i = 0; i < 10; i += 1) {
      await tinySink.emit({ source: 'supervisor', type: 'supervisor.heartbeat' });
    }

    const records = await tiny.peek(100);
    const markers = records.filter((r) => (r.payload as { code?: string }).code === 'events_dropped');
    expect(markers.length).toBeGreaterThan(0);
    expect(markers[0]?.payload).toMatchObject({ code: 'events_dropped' });
    await tiny.close();
  });
});

describe('relayOnce', () => {
  it('does nothing on an empty spool', async () => {
    expect(await relayOnce(spool, orchestrator)).toEqual({
      delivered: 0,
      rejected: 0,
      deferred: false,
    });
    expect(orchestrator.batches).toHaveLength(0);
  });

  it('delivers a batch and drops it from the spool', async () => {
    await sink.emit({ source: 'supervisor', type: 'supervisor.heartbeat' });
    await sink.emit({ source: 'supervisor', type: 'supervisor.heartbeat' });

    const outcome = await relayOnce(spool, orchestrator);

    expect(outcome).toEqual({ delivered: 2, rejected: 0, deferred: false });
    expect(orchestrator.delivered).toHaveLength(2);
    expect(await spool.peek(10)).toEqual([]);
  });

  it('never sends more than the orchestrator will accept', async () => {
    for (let i = 0; i < MAX_BATCH + 10; i += 1) {
      await sink.emit({ source: 'supervisor', type: 'supervisor.heartbeat' });
    }

    await relayOnce(spool, orchestrator);

    expect(orchestrator.batches[0]).toHaveLength(MAX_BATCH);
    expect(await spool.peek(1000)).toHaveLength(10);
  });

  // An orchestrator that is down is the case the spool exists for.
  it('leaves the spool intact when the orchestrator is unreachable', async () => {
    await sink.emit({ source: 'supervisor', type: 'supervisor.heartbeat' });
    orchestrator.nextPostResults = [
      { ok: false, retryable: true, status: null, message: 'connect ECONNREFUSED' },
    ];

    const outcome = await relayOnce(spool, orchestrator);

    expect(outcome.deferred).toBe(true);
    expect(await spool.peek(10)).toHaveLength(1);
  });

  it('retries the same batch on the next pass and then succeeds', async () => {
    await sink.emit({ source: 'supervisor', type: 'supervisor.heartbeat' });
    orchestrator.nextPostResults = [{ ok: false, retryable: true, status: 503, message: '' }];

    await relayOnce(spool, orchestrator);
    const second = await relayOnce(spool, orchestrator);

    expect(second.delivered).toBe(1);
    expect(await spool.peek(10)).toEqual([]);
  });

  // A refusal is an emitter bug. Retrying it forever would wedge every later
  // event behind one bad record.
  it('sets a refused batch aside rather than wedging the spool', async () => {
    await sink.emit({ source: 'supervisor', type: 'supervisor.heartbeat' });
    orchestrator.nextPostResults = [
      { ok: false, retryable: false, status: 400, message: 'invalid_event' },
    ];

    const outcome = await relayOnce(spool, orchestrator);

    expect(outcome.rejected).toBe(1);
    expect(await spool.peek(10)).toEqual([]);
    const rejected = await readFile(`${path.join(dir, 'events.jsonl')}.rejected`, 'utf8');
    expect(rejected).toContain('supervisor.heartbeat');
  });

  it('keeps draining after a refusal', async () => {
    await sink.emit({ source: 'supervisor', type: 'supervisor.heartbeat' });
    orchestrator.nextPostResults = [
      { ok: false, retryable: false, status: 400, message: 'invalid_event' },
    ];
    await relayOnce(spool, orchestrator);

    await sink.emit({ source: 'supervisor', type: 'error' });
    const outcome = await relayOnce(spool, orchestrator);

    expect(outcome.delivered).toBe(1);
  });
});
