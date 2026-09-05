import { describe, expect, it } from 'vitest';
import { validateEvent } from '../src/index.js';
import { validEvent } from './fixtures/valid-plan.js';

describe('validateEvent - envelope', () => {
  it('accepts the minimal valid envelope', () => {
    expect(validateEvent(validEvent()).ok).toBe(true);
  });

  it('applies severity and payload defaults', () => {
    const result = validateEvent(validEvent());
    if (!result.ok) throw new Error('expected valid');
    expect(result.value.severity).toBe('info');
    expect(result.value.payload).toEqual({});
  });

  it('accepts plan and task correlation ids', () => {
    const event = validEvent();
    event.plan_id = '018f3a5c-0000-7000-8000-00000000000a';
    event.task_id = '018f3a5c-0000-7000-8000-00000000000b';
    expect(validateEvent(event).ok).toBe(true);
  });

  it('accepts an arbitrary payload object, since v1 does not type payloads', () => {
    const event = validEvent();
    event.payload = { tool: 'bash', argv: ['ls'], exit_code: 0 };
    expect(validateEvent(event).ok).toBe(true);
  });

  it('does not mutate the input document', () => {
    const event = validEvent();
    const before = JSON.stringify(event);
    validateEvent(event);
    expect(JSON.stringify(event)).toBe(before);
  });
});

describe('validateEvent - ordering and identity (G4)', () => {
  it('requires event_id, which is the replay idempotency key', () => {
    const event = validEvent();
    delete event.event_id;
    expect(validateEvent(event).ok).toBe(false);
  });

  it('rejects an event_id that is not a uuid', () => {
    const event = validEvent();
    event.event_id = 'not-a-uuid';
    expect(validateEvent(event).ok).toBe(false);
  });

  it('requires stream_id, which scopes seq', () => {
    const event = validEvent();
    delete event.stream_id;
    expect(validateEvent(event).ok).toBe(false);
  });

  it('requires seq, which orders buffered replay', () => {
    const event = validEvent();
    delete event.seq;
    expect(validateEvent(event).ok).toBe(false);
  });

  it('rejects a negative seq', () => {
    const event = validEvent();
    event.seq = -1;
    expect(validateEvent(event).ok).toBe(false);
  });

  it('rejects a non-integer seq', () => {
    const event = validEvent();
    event.seq = 1.5;
    expect(validateEvent(event).ok).toBe(false);
  });

  it('rejects a ts that is not an RFC 3339 timestamp', () => {
    const event = validEvent();
    event.ts = '2026-09-02';
    expect(validateEvent(event).ok).toBe(false);
  });
});

describe('validateEvent - shape', () => {
  it('rejects a source outside the three tiers', () => {
    const event = validEvent();
    event.source = 'sandbox';
    expect(validateEvent(event).ok).toBe(false);
  });

  it('rejects an unknown event type', () => {
    const event = validEvent();
    event.type = 'agent.telepathy';
    expect(validateEvent(event).ok).toBe(false);
  });

  it('rejects an unknown envelope field', () => {
    const event = validEvent();
    event.cost_usd = 0.02;
    expect(validateEvent(event).ok).toBe(false);
  });

  it('accepts every declared event type', () => {
    const types = [
      'plan.state_changed',
      'task.state_changed',
      'task.dispatched',
      'task.lease_expired',
      'agent.model_call',
      'agent.tool_call',
      'sandbox.launched',
      'sandbox.exited',
      'limit.exceeded',
      'supervisor.heartbeat',
      'operator.action',
      'egress.allowed',
      'egress.denied',
      'environment.state_changed',
      'error',
    ];
    for (const type of types) {
      const event = validEvent();
      event.type = type;
      expect(validateEvent(event).ok, type).toBe(true);
    }
  });

  // Baseline section 7 requires that every allowed and rejected egress request
  // is an event. Without these two types the supervisor's proxy has nothing to
  // record them as.
  it('accepts an egress decision carrying the host, port, and matching rule', () => {
    const allowed = validEvent();
    allowed.source = 'supervisor';
    allowed.type = 'egress.allowed';
    allowed.payload = { host: 'api.github.com', port: 443, rule: '*.github.com' };
    expect(validateEvent(allowed).ok).toBe(true);

    const denied = validEvent();
    denied.source = 'supervisor';
    denied.type = 'egress.denied';
    denied.payload = { host: 'evil.example', port: 443, rule: null };
    expect(validateEvent(denied).ok).toBe(true);
  });

  it('accepts an environment lifecycle change', () => {
    const event = validEvent();
    event.source = 'supervisor';
    event.type = 'environment.state_changed';
    event.payload = { from: 'running', to: 'torn_down', reason: 'completion' };
    expect(validateEvent(event).ok).toBe(true);
  });
});
