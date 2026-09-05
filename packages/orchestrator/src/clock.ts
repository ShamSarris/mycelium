/**
 * Time is injected so tests can drive leases, TTLs, and heartbeat health
 * without sleeping. Business logic must never call Date.now() directly.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};
