/**
 * Time is injected so tests can drive wall-clock limits, status retries, and
 * the shutdown budget without sleeping. Business logic must never call
 * Date.now() directly. Deliberately identical to the supervisor's and the
 * orchestrator's, so all three behave the same way under a controlled clock.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};
