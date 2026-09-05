import { describe, expect, it } from 'vitest';
import { MAX_DELAY_MS, nextAttemptDelay } from '../../src/domain/backoff.js';

describe('nextAttemptDelay', () => {
  it('starts at five seconds', () => {
    expect(nextAttemptDelay(1)).toBe(5_000);
  });

  it('doubles on each attempt', () => {
    expect(nextAttemptDelay(2)).toBe(10_000);
    expect(nextAttemptDelay(3)).toBe(20_000);
    expect(nextAttemptDelay(4)).toBe(40_000);
    expect(nextAttemptDelay(5)).toBe(80_000);
    expect(nextAttemptDelay(6)).toBe(160_000);
  });

  it('caps at five minutes', () => {
    expect(nextAttemptDelay(7)).toBe(MAX_DELAY_MS);
    expect(nextAttemptDelay(50)).toBe(MAX_DELAY_MS);
  });

  it('never overflows for an absurd attempt count', () => {
    expect(nextAttemptDelay(10_000)).toBe(MAX_DELAY_MS);
  });

  it('treats attempt zero as the first attempt', () => {
    expect(nextAttemptDelay(0)).toBe(5_000);
  });
});
