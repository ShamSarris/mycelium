import { describe, expect, it } from 'vitest';
import { isAlert, ALERT_EVENT_TYPES } from '../../src/domain/alerts.js';

/**
 * What counts as an alert, pure.
 *
 * An alert is something that **already happened and will never resurface on
 * its own**. That is what separates it from the needs-attention queue, which
 * holds work that is waiting: a plan in `proposed` clears by approving it,
 * whereas a TTL auto-fail or a dropped-event overflow leaves nothing in a
 * waiting state and is simply gone if nobody looks.
 *
 * The rule lives in one function so the whole set is readable at once, and so
 * the near misses can be tested without a database.
 */

function event(overrides: Record<string, unknown> = {}) {
  return {
    type: 'error',
    severity: 'error',
    payload: {},
    ...overrides,
  } as Parameters<typeof isAlert>[0];
}

describe('isAlert', () => {
  it('takes any error-severity event, from any source', () => {
    expect(isAlert(event({ type: 'error', severity: 'error' }))).toBe(true);
    expect(isAlert(event({ type: 'task.state_changed', severity: 'error' }))).toBe(true);
    expect(isAlert(event({ type: 'egress.denied', severity: 'error' }))).toBe(true);
  });

  it('takes a plan halted for budget', () => {
    expect(
      isAlert(event({ type: 'limit.exceeded', severity: 'warn', payload: { limit: 'plan_cost' } })),
    ).toBe(true);
  });

  it('takes an environment orphaned by a restart, or expired', () => {
    for (const reason of ['orphan_after_restart', 'ttl_expired']) {
      expect(
        isAlert(event({ type: 'environment.state_changed', severity: 'warn', payload: { reason } })),
      ).toBe(true);
    }
  });

  it('leaves the ordinary warnings alone', () => {
    // A task's own token ceiling is the failure policy's business and shows on
    // the plan; it is not something that needs acknowledging.
    expect(
      isAlert(event({ type: 'limit.exceeded', severity: 'warn', payload: { limit: 'tokens' } })),
    ).toBe(false);
    expect(
      isAlert(
        event({ type: 'limit.exceeded', severity: 'warn', payload: { limit: 'commit_cadence' } }),
      ),
    ).toBe(false);
  });

  it('leaves an ordinary environment transition alone', () => {
    expect(
      isAlert(
        event({
          type: 'environment.state_changed',
          severity: 'info',
          payload: { reason: 'dispatched' },
        }),
      ),
    ).toBe(false);
  });

  it('does not take an info or debug event whatever its type', () => {
    expect(isAlert(event({ type: 'plan.state_changed', severity: 'info' }))).toBe(false);
    expect(isAlert(event({ type: 'agent.tool_call', severity: 'debug' }))).toBe(false);
  });

  it('tolerates a missing or malformed payload', () => {
    // Payloads are untyped in v1 and come from three services; the rule must
    // not throw on one it did not expect.
    expect(isAlert(event({ type: 'limit.exceeded', severity: 'warn', payload: undefined }))).toBe(
      false,
    );
    expect(
      isAlert(event({ type: 'environment.state_changed', severity: 'warn', payload: null })),
    ).toBe(false);
  });

  it('names the warn-severity types it considers, so the SQL and the rule agree', () => {
    // The query prefilters on these; if the two lists drift, an alert either
    // never appears or is fetched and then discarded.
    expect([...ALERT_EVENT_TYPES].sort()).toEqual(['environment.state_changed', 'limit.exceeded']);
  });
});
