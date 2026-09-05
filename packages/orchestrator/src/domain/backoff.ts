/**
 * Provisioning backoff: 5 s doubling to a 5 min cap.
 *
 * A queued plan whose candidates all reject is waiting on capacity somewhere
 * else, so retrying hard buys nothing. The cap keeps a plan responsive once a
 * VM frees up.
 */

export const BASE_DELAY_MS = 5_000;
export const MAX_DELAY_MS = 300_000;

/** `attempt` is 1 for the first retry. Values below 1 are treated as 1. */
export function nextAttemptDelay(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt));
  // Cap the exponent before shifting so a large attempt count cannot overflow.
  const exponent = Math.min(n - 1, 20);
  return Math.min(BASE_DELAY_MS * 2 ** exponent, MAX_DELAY_MS);
}
