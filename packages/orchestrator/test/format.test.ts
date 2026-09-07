import { describe, expect, it } from 'vitest';
import { formatCost } from '../src/views/format.js';

/**
 * `formatCost` is the only place a microusd integer becomes a dollar string.
 * Storage is microusd (integer millionths of a US dollar); display is dollars.
 *
 * The rounding rule (ticket 06 §6.2): under $10, cents to two decimal places
 * (`$4.20`); at or above $10, whole dollars with a thousands separator
 * (`$1,204`); and anything greater than zero but less than a cent renders as
 * `<$0.01` rather than `$0.00` — a task that cost something must never look
 * free.
 */
describe('formatCost', () => {
  it('renders zero as $0.00', () => {
    expect(formatCost(0)).toBe('$0.00');
  });

  it('renders a sub-cent amount as less-than-a-cent, never as free', () => {
    expect(formatCost(1)).toBe('<$0.01');
    expect(formatCost(9_999)).toBe('<$0.01');
  });

  it('renders exactly one cent', () => {
    expect(formatCost(10_000)).toBe('$0.01');
  });

  it('renders $9.99, just under the whole-dollar threshold', () => {
    expect(formatCost(9_990_000)).toBe('$9.99');
  });

  it('renders $10 as a whole dollar amount, not $10.00', () => {
    expect(formatCost(10_000_000)).toBe('$10');
  });

  it('thousands-separates a large whole-dollar amount', () => {
    expect(formatCost(1_204_000_000)).toBe('$1,204');
  });

  it('handles a value past 2^31 microusd without overflow or truncation', () => {
    // 2^31 microusd is about $2,147.48. Use a value comfortably past it.
    expect(formatCost(5_000_000_000)).toBe('$5,000');
  });

  it('never renders a positive amount as $0.00', () => {
    for (const microusd of [1, 100, 9_999, 10_000, 500_000, 9_990_000]) {
      expect(formatCost(microusd)).not.toBe('$0.00');
    }
  });
});
