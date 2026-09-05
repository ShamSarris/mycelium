import { describe, expect, it } from 'vitest';
import {
  ENVIRONMENT_STATES,
  IllegalTransition,
  assertTransition,
  canTransition,
  isTerminal,
} from '../../src/domain/states.js';
import { canAdmit, canLaunchSandbox } from '../../src/domain/admission.js';

// Encoded as data and tested as a table, the same way the orchestrator's two
// machines are. Nothing outside the table is reachable.
const LEGAL: Array<[string, string]> = [
  ['provisioning', 'running'],
  ['provisioning', 'failed'],
  ['running', 'tearing_down'],
  ['tearing_down', 'torn_down'],
];

describe('environment state machine', () => {
  it.each(LEGAL)('allows %s to %s', (from, to) => {
    expect(canTransition(from as never, to as never)).toBe(true);
    expect(() => assertTransition(from as never, to as never)).not.toThrow();
  });

  it('refuses every transition the table does not list', () => {
    for (const from of ENVIRONMENT_STATES) {
      for (const to of ENVIRONMENT_STATES) {
        const legal = LEGAL.some(([f, t]) => f === from && t === to);
        if (legal) continue;
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(false);
        expect(() => assertTransition(from, to), `${from} -> ${to}`).toThrow(IllegalTransition);
      }
    }
  });

  it('names both states in the error, so a log line explains itself', () => {
    expect(() => assertTransition('torn_down', 'running')).toThrow(/torn_down.*running/);
  });

  it('treats torn_down and failed as terminal', () => {
    expect(isTerminal('torn_down')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
    expect(isTerminal('running')).toBe(false);
    expect(isTerminal('provisioning')).toBe(false);
    expect(isTerminal('tearing_down')).toBe(false);
  });
});

// B21: one integer. The supervisor owning rejection is what makes the
// orchestrator's first-fit self-correcting, so this is a correctness boundary
// rather than an optimisation.
describe('canAdmit', () => {
  it('admits below the cap', () => {
    expect(canAdmit(0, 2)).toBe(true);
    expect(canAdmit(1, 2)).toBe(true);
  });

  it('refuses at the cap', () => {
    expect(canAdmit(2, 2)).toBe(false);
  });

  it('refuses above the cap, which a restart scan can produce', () => {
    expect(canAdmit(3, 2)).toBe(false);
  });
});

describe('canLaunchSandbox', () => {
  it('admits below the per-environment cap and refuses at it', () => {
    expect(canLaunchSandbox(3, 4)).toBe(true);
    expect(canLaunchSandbox(4, 4)).toBe(false);
  });
});
