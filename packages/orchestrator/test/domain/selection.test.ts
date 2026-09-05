import { describe, expect, it } from 'vitest';
import {
  HEARTBEAT_HEALTHY_MS,
  isHealthy,
  selectSupervisors,
  type SupervisorCandidate,
} from '../../src/domain/selection.js';

const NOW = new Date('2026-09-02T12:00:00.000Z');

function candidate(overrides: Partial<SupervisorCandidate> = {}): SupervisorCandidate {
  return {
    id: '018f3a5c-0000-7000-8000-000000000001',
    name: 'worker-dev-1',
    env: 'dev',
    base_url: 'http://worker-1:8080',
    enabled: true,
    priority: 100,
    last_heartbeat_at: new Date(NOW.getTime() - 10_000),
    ...overrides,
  };
}

describe('isHealthy', () => {
  it('accepts a supervisor that heartbeat a moment ago', () => {
    expect(isHealthy(candidate(), NOW)).toBe(true);
  });

  it('accepts a supervisor exactly at the two-minute boundary', () => {
    const at = new Date(NOW.getTime() - HEARTBEAT_HEALTHY_MS);
    expect(isHealthy(candidate({ last_heartbeat_at: at }), NOW)).toBe(true);
  });

  it('rejects a supervisor one millisecond past the boundary', () => {
    const at = new Date(NOW.getTime() - HEARTBEAT_HEALTHY_MS - 1);
    expect(isHealthy(candidate({ last_heartbeat_at: at }), NOW)).toBe(false);
  });

  it('rejects a supervisor that has never heartbeat', () => {
    expect(isHealthy(candidate({ last_heartbeat_at: null }), NOW)).toBe(false);
  });
});

describe('selectSupervisors', () => {
  it('returns an empty list for no candidates', () => {
    expect(selectSupervisors([], { env: 'dev', now: NOW })).toEqual([]);
  });

  it('skips a candidate registered for another environment', () => {
    const result = selectSupervisors([candidate({ env: 'prod' })], { env: 'dev', now: NOW });
    expect(result).toEqual([]);
  });

  it('skips a disabled candidate', () => {
    const result = selectSupervisors([candidate({ enabled: false })], { env: 'dev', now: NOW });
    expect(result).toEqual([]);
  });

  it('skips a candidate that has been silent for over two minutes', () => {
    const stale = candidate({ last_heartbeat_at: new Date(NOW.getTime() - 121_000) });
    expect(selectSupervisors([stale], { env: 'dev', now: NOW })).toEqual([]);
  });

  it('orders by priority ascending, so the lower number is tried first', () => {
    const low = candidate({ id: 'b', priority: 10 });
    const high = candidate({ id: 'a', priority: 200 });
    const result = selectSupervisors([high, low], { env: 'dev', now: NOW });
    expect(result.map((c) => c.id)).toEqual(['b', 'a']);
  });

  it('breaks a priority tie on id, so selection is deterministic and replayable', () => {
    const second = candidate({ id: 'bbb', priority: 100 });
    const first = candidate({ id: 'aaa', priority: 100 });
    const result = selectSupervisors([second, first], { env: 'dev', now: NOW });
    expect(result.map((c) => c.id)).toEqual(['aaa', 'bbb']);
  });

  it('returns every healthy candidate, because first-fit needs the fallbacks', () => {
    const result = selectSupervisors(
      [candidate({ id: 'a' }), candidate({ id: 'b' }), candidate({ id: 'c' })],
      { env: 'dev', now: NOW },
    );
    expect(result).toHaveLength(3);
  });

  it('does not mutate the input array', () => {
    const input = [candidate({ id: 'b', priority: 1 }), candidate({ id: 'a', priority: 2 })];
    const before = input.map((c) => c.id);
    selectSupervisors(input, { env: 'dev', now: NOW });
    expect(input.map((c) => c.id)).toEqual(before);
  });

  it('honours an overridden health window', () => {
    const stale = candidate({ last_heartbeat_at: new Date(NOW.getTime() - 300_000) });
    const result = selectSupervisors([stale], {
      env: 'dev',
      now: NOW,
      healthyWithinMs: 600_000,
    });
    expect(result).toHaveLength(1);
  });
});
