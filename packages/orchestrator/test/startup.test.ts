import { afterEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { acquireSingleWriterLock } from '../src/index.js';
import { loadConfig } from '../src/config.js';
import { MIGRATIONS_DIR, TEST_DATABASE_URL } from './helpers/db.js';

const config = loadConfig({ DATABASE_URL: TEST_DATABASE_URL, MIGRATIONS_DIR });

const holders: pg.Client[] = [];

afterEach(async () => {
  while (holders.length > 0) {
    await holders.pop()?.end().catch(() => undefined);
  }
});

describe('the single-writer advisory lock', () => {
  it('is granted to the first orchestrator', async () => {
    const client = await acquireSingleWriterLock(config);
    holders.push(client);
    expect(client).toBeDefined();
  });

  it('refuses a second orchestrator against the same database', async () => {
    holders.push(await acquireSingleWriterLock(config));

    await expect(acquireSingleWriterLock(config)).rejects.toThrow(
      /another orchestrator holds the single-writer advisory lock/,
    );
  });

  it('is released when the holder disconnects, so a restart succeeds', async () => {
    const first = await acquireSingleWriterLock(config);
    await first.end();

    const second = await acquireSingleWriterLock(config);
    holders.push(second);
    expect(second).toBeDefined();
  });
});

describe('loadConfig', () => {
  it('binds to loopback by default, because Serve is the only front door', () => {
    expect(loadConfig({}).host).toBe('127.0.0.1');
  });

  it('starts with an empty operator allowlist, so nothing is authorised by accident', () => {
    expect(loadConfig({}).operatorAllowlist).toEqual([]);
  });

  it('splits and trims the allowlist', () => {
    const parsed = loadConfig({ OPERATOR_ALLOWLIST: 'a@x.com, b@x.com ,' });
    expect(parsed.operatorAllowlist).toEqual(['a@x.com', 'b@x.com']);
  });

  it('carries the timings the baseline does not fix', () => {
    const parsed = loadConfig({});
    expect(parsed.leaseSeconds).toBe(60);
    expect(parsed.wallClockGraceMinutes).toBe(2);
    expect(parsed.supervisorLostMinutes).toBe(5);
    expect(parsed.heartbeatHealthyMinutes).toBe(2);
  });

  it('lets the operator override every timing', () => {
    const parsed = loadConfig({
      LEASE_SECONDS: '30',
      WALL_CLOCK_GRACE_MIN: '10',
      SUPERVISOR_LOST_MIN: '600',
      HEARTBEAT_HEALTHY_MIN: '3',
    });
    expect(parsed.leaseSeconds).toBe(30);
    expect(parsed.wallClockGraceMinutes).toBe(10);
    expect(parsed.supervisorLostMinutes).toBe(600);
    expect(parsed.heartbeatHealthyMinutes).toBe(3);
  });

  it('refuses a timing that is not a number', () => {
    expect(() => loadConfig({ LEASE_SECONDS: 'soon' })).toThrow(/expected an integer/);
  });
});
