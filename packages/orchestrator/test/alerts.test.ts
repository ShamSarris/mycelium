import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { acknowledgeAlert, listAlerts } from '../src/services/alerts.js';
import { withTransaction } from '../src/db/pool.js';
import { recordEvent } from '../src/services/events.js';
import { buildTestApp, OPERATOR, type TestHarness } from './helpers/app.js';
import { eventTypes, propose, validPlan } from './helpers/fixtures.js';

/**
 * The alert list: a query over the event log, plus a record of what has been
 * dealt with. It is the only cross-plan read of `events` in the system, which
 * is deliberate — every other view is scoped to a plan.
 */

let h: TestHarness;

beforeAll(async () => {
  h = await buildTestApp();
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await h.reset();
});

async function emit(
  planId: string,
  event: { type: string; severity: string; payload?: Record<string, unknown> },
): Promise<string> {
  return withTransaction(h.pool, (client) =>
    recordEvent(client, h.deps, {
      type: event.type as Parameters<typeof recordEvent>[2]['type'],
      severity: event.severity as 'warn' | 'error',
      planId,
      payload: event.payload ?? {},
    }),
  );
}

describe('listAlerts', () => {
  it('returns an error-severity event', async () => {
    const { plan_id } = await propose(h, validPlan());
    await emit(plan_id, { type: 'error', severity: 'error', payload: { stage: 'model_call' } });

    const alerts = await listAlerts(h.deps);

    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.type).toBe('error');
    expect(alerts[0]?.plan_id).toBe(plan_id);
  });

  it('spans plans, which no other event read does', async () => {
    const first = await propose(h, validPlan());
    const second = await propose(h, { ...validPlan(), goal: 'Something else entirely.' });
    await emit(first.plan_id, { type: 'error', severity: 'error' });
    await emit(second.plan_id, { type: 'error', severity: 'error' });

    // `GET /events` requires a plan_id. An alert list that did too would be
    // useless as the thing you check when you do not know what broke.
    expect(await listAlerts(h.deps)).toHaveLength(2);
  });

  it('leaves out the warnings that are not alerts', async () => {
    const { plan_id } = await propose(h, validPlan());
    await emit(plan_id, {
      type: 'limit.exceeded',
      severity: 'warn',
      payload: { limit: 'commit_cadence' },
    });
    await emit(plan_id, { type: 'plan.state_changed', severity: 'info' });

    expect(await listAlerts(h.deps)).toHaveLength(0);
  });

  it('includes a plan halted for budget and an orphaned environment', async () => {
    const { plan_id } = await propose(h, validPlan());
    await emit(plan_id, {
      type: 'limit.exceeded',
      severity: 'warn',
      payload: { limit: 'plan_tokens' },
    });
    await emit(plan_id, {
      type: 'environment.state_changed',
      severity: 'warn',
      payload: { reason: 'orphan_after_restart' },
    });

    expect(await listAlerts(h.deps)).toHaveLength(2);
  });

  it('puts the newest first, because that is what you look at', async () => {
    const { plan_id } = await propose(h, validPlan());
    const older = await emit(plan_id, { type: 'error', severity: 'error', payload: { n: 1 } });
    h.clock.advance(60_000);
    const newer = await emit(plan_id, { type: 'error', severity: 'error', payload: { n: 2 } });

    const alerts = await listAlerts(h.deps);

    expect(alerts[0]?.event_id).toBe(newer);
    expect(alerts[1]?.event_id).toBe(older);
  });
});

describe('acknowledgeAlert', () => {
  it('removes it from the list', async () => {
    const { plan_id } = await propose(h, validPlan());
    const eventId = await emit(plan_id, { type: 'error', severity: 'error' });

    await acknowledgeAlert(h.deps, { eventId, operator: OPERATOR });

    expect(await listAlerts(h.deps)).toHaveLength(0);
  });

  it('leaves the event itself untouched, because the alert was only a view of it', async () => {
    const { plan_id } = await propose(h, validPlan());
    const eventId = await emit(plan_id, { type: 'error', severity: 'error' });

    await acknowledgeAlert(h.deps, { eventId, operator: OPERATOR });

    const { rows } = await h.pool.query('SELECT event_id FROM events WHERE event_id = $1', [
      eventId,
    ]);
    expect(rows).toHaveLength(1);
  });

  it('records who did it, as an operator action', async () => {
    const { plan_id } = await propose(h, validPlan());
    const eventId = await emit(plan_id, { type: 'error', severity: 'error' });

    await acknowledgeAlert(h.deps, { eventId, operator: OPERATOR });

    expect(await eventTypes(h, plan_id)).toContain('operator.action');
    const { rows } = await h.pool.query<{ acknowledged_by: string }>(
      'SELECT acknowledged_by FROM alert_acknowledgements WHERE event_id = $1',
      [eventId],
    );
    expect(rows[0]?.acknowledged_by).toBe(OPERATOR);
  });

  it('is not an error the second time', async () => {
    const { plan_id } = await propose(h, validPlan());
    const eventId = await emit(plan_id, { type: 'error', severity: 'error' });

    await acknowledgeAlert(h.deps, { eventId, operator: OPERATOR });

    // Two taps on a phone, or a reload of a page that already acted.
    await expect(acknowledgeAlert(h.deps, { eventId, operator: OPERATOR })).resolves.toBeDefined();
    expect(await listAlerts(h.deps)).toHaveLength(0);
  });

  it('refuses an event that does not exist', async () => {
    await expect(
      acknowledgeAlert(h.deps, {
        eventId: '018f3a5c-0000-7000-8000-0000000000ff',
        operator: OPERATOR,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses an event that is not an alert', async () => {
    const { plan_id } = await propose(h, validPlan());
    const eventId = await emit(plan_id, { type: 'plan.state_changed', severity: 'info' });

    // Acknowledging something that was never on the list would leave a row
    // nothing reads and suggest the list had held it.
    await expect(
      acknowledgeAlert(h.deps, { eventId, operator: OPERATOR }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
