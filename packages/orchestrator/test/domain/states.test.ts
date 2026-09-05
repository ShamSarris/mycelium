import { describe, expect, it } from 'vitest';
import {
  IllegalTransition,
  PLAN_STATES,
  TASK_STATES,
  assertPlanTransition,
  assertTaskTransition,
  canPlanTransition,
  canTaskTransition,
  isPlanTerminal,
  isTaskTerminal,
  type PlanState,
  type TaskState,
} from '../../src/domain/states.js';

// Every row of the baseline section 6 tables, as data. A transition missing
// from here must be rejected, which is what stops a handler inventing one.
const ALLOWED_PLAN: Array<[PlanState, PlanState]> = [
  ['proposed', 'queued'],
  ['proposed', 'rejected'],
  ['queued', 'provisioning'],
  ['provisioning', 'running'],
  ['provisioning', 'queued'],
  ['provisioning', 'finalizing'],
  ['running', 'finalizing'],
  ['finalizing', 'done'],
  ['finalizing', 'failed'],
];

const ALLOWED_TASK: Array<[TaskState, TaskState]> = [
  ['pending', 'ready'],
  ['ready', 'dispatched'],
  ['dispatched', 'running'],
  ['dispatched', 'ready'],
  ['running', 'done'],
  ['running', 'failed'],
  ['running', 'ready'],
];

describe('plan state machine', () => {
  for (const [from, to] of ALLOWED_PLAN) {
    it(`allows ${from} to ${to}`, () => {
      expect(canPlanTransition(from, to)).toBe(true);
    });
  }

  it('allows cancellation from every non-terminal state', () => {
    for (const state of PLAN_STATES) {
      if (isPlanTerminal(state)) continue;
      expect(canPlanTransition(state, 'cancelled'), state).toBe(true);
    }
  });

  it('allows nothing out of a terminal state', () => {
    for (const state of PLAN_STATES) {
      if (!isPlanTerminal(state)) continue;
      for (const to of PLAN_STATES) {
        expect(canPlanTransition(state, to), `${state} to ${to}`).toBe(false);
      }
    }
  });

  it('rejects every pair not in the table', () => {
    const allowed = new Set(ALLOWED_PLAN.map(([f, t]) => `${f}>${t}`));
    for (const from of PLAN_STATES) {
      for (const to of PLAN_STATES) {
        if (allowed.has(`${from}>${to}`)) continue;
        if (to === 'cancelled' && !isPlanTerminal(from)) continue;
        expect(canPlanTransition(from, to), `${from} to ${to}`).toBe(false);
      }
    }
  });

  it('throws IllegalTransition rather than returning false when asserted', () => {
    expect(() => assertPlanTransition('done', 'running')).toThrow(IllegalTransition);
    expect(() => assertPlanTransition('proposed', 'queued')).not.toThrow();
  });

  it('names both states in the thrown error', () => {
    try {
      assertPlanTransition('running', 'queued');
      throw new Error('expected a throw');
    } catch (error) {
      expect((error as IllegalTransition).from).toBe('running');
      expect((error as IllegalTransition).to).toBe('queued');
      expect((error as IllegalTransition).code).toBe('illegal_transition');
    }
  });

  it('treats a plan that never provisioned as still cancellable', () => {
    expect(canPlanTransition('proposed', 'cancelled')).toBe(true);
  });
});

describe('task state machine', () => {
  for (const [from, to] of ALLOWED_TASK) {
    it(`allows ${from} to ${to}`, () => {
      expect(canTaskTransition(from, to)).toBe(true);
    });
  }

  it('allows cancellation from every non-terminal state', () => {
    for (const state of TASK_STATES) {
      if (isTaskTerminal(state)) continue;
      expect(canTaskTransition(state, 'cancelled'), state).toBe(true);
    }
  });

  it('rejects every pair not in the table', () => {
    const allowed = new Set(ALLOWED_TASK.map(([f, t]) => `${f}>${t}`));
    for (const from of TASK_STATES) {
      for (const to of TASK_STATES) {
        if (allowed.has(`${from}>${to}`)) continue;
        if (to === 'cancelled' && !isTaskTerminal(from)) continue;
        expect(canTaskTransition(from, to), `${from} to ${to}`).toBe(false);
      }
    }
  });

  it('does not allow a dispatched task to report done without acknowledging first', () => {
    expect(canTaskTransition('dispatched', 'done')).toBe(false);
  });

  it('does not allow a failed task to be retried by state change alone', () => {
    expect(canTaskTransition('failed', 'ready')).toBe(false);
  });

  it('throws IllegalTransition when asserted', () => {
    expect(() => assertTaskTransition('done', 'running')).toThrow(IllegalTransition);
  });
});

describe('terminality', () => {
  it('names the four terminal plan states', () => {
    expect(PLAN_STATES.filter(isPlanTerminal)).toEqual(['done', 'failed', 'rejected', 'cancelled']);
  });

  it('names the three terminal task states', () => {
    expect(TASK_STATES.filter(isTaskTerminal)).toEqual(['done', 'failed', 'cancelled']);
  });
});
