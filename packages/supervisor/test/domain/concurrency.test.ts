import { describe, expect, it } from 'vitest';
import { deriveMaxConcurrentSubagents } from '../../src/domain/concurrency.js';

/**
 * Ticket 13: `max_concurrent_agents` was removed from `plan.schema.json` by
 * ticket 03 — an operator has no idea what the VM can take, only the
 * supervisor does, from the memory ceiling it itself sets on the plan's
 * `systemd-run --scope` (`drivers/cgroup.ts` `wrap()`). This is the pure
 * derivation, tested with no SDK, no subprocess, no network.
 */

const GiB = 1024 ** 3;

describe('deriveMaxConcurrentSubagents', () => {
  it('derives 1 from a 2 GiB scope', () => {
    expect(deriveMaxConcurrentSubagents(2 * GiB)).toBe(1);
  });

  it('derives a sensible headroom-adjusted number from an 8 GiB scope', () => {
    // 8 GiB - 1 GiB reserved for the parent process itself, at ~1 GiB per
    // subagent: 7.
    expect(deriveMaxConcurrentSubagents(8 * GiB)).toBe(7);
  });

  it('defaults conservatively, never to the SDK-s own 20, when no ceiling is set', () => {
    const result = deriveMaxConcurrentSubagents(undefined);
    expect(result).toBeGreaterThanOrEqual(1);
    expect(result).toBeLessThan(20);
  });

  it('never returns 0, even for a nonsensical tiny ceiling', () => {
    expect(deriveMaxConcurrentSubagents(1)).toBeGreaterThanOrEqual(1);
    expect(deriveMaxConcurrentSubagents(0)).toBeGreaterThanOrEqual(1);
  });

  it('never returns 0 for a ceiling smaller than the reserve plus one subagent', () => {
    // 1 GiB scope: entirely consumed by the parent-process reserve, with
    // nothing left over for a subagent slice. Still at least 1, not 0.
    expect(deriveMaxConcurrentSubagents(1 * GiB)).toBe(1);
  });

  it('scales down monotonically as the ceiling shrinks', () => {
    const at8 = deriveMaxConcurrentSubagents(8 * GiB);
    const at4 = deriveMaxConcurrentSubagents(4 * GiB);
    const at2 = deriveMaxConcurrentSubagents(2 * GiB);
    expect(at8).toBeGreaterThanOrEqual(at4);
    expect(at4).toBeGreaterThanOrEqual(at2);
  });
});
