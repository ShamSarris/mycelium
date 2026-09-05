/**
 * Time is injected so tests can drive TTLs, teardown grace, and heartbeat
 * intervals without sleeping. Business logic must never call Date.now()
 * directly. Deliberately identical to the orchestrator's, so the two services
 * behave the same way under a controlled clock.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};
