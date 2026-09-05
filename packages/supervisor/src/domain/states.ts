/**
 * The plan environment's lifecycle, encoded as data and refused outside the
 * table — the same discipline the orchestrator applies to its plan and task
 * machines, so no handler can invent a transition.
 *
 * This machine is local to one VM and is not the plan's state. The orchestrator
 * owns that; these states only describe what this supervisor is holding.
 */
export const ENVIRONMENT_STATES = [
  'provisioning',
  'running',
  'tearing_down',
  'torn_down',
  'failed',
] as const;

export type EnvironmentState = (typeof ENVIRONMENT_STATES)[number];

const TRANSITIONS: Record<EnvironmentState, readonly EnvironmentState[]> = {
  provisioning: ['running', 'failed'],
  running: ['tearing_down'],
  tearing_down: ['torn_down'],
  torn_down: [],
  failed: [],
};

const TERMINAL = new Set<EnvironmentState>(['torn_down', 'failed']);

export class IllegalTransition extends Error {
  readonly code = 'illegal_transition';

  constructor(from: EnvironmentState, to: EnvironmentState) {
    super(`an environment cannot move from ${from} to ${to}`);
    this.name = 'IllegalTransition';
  }
}

export function canTransition(from: EnvironmentState, to: EnvironmentState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: EnvironmentState, to: EnvironmentState): void {
  if (!canTransition(from, to)) throw new IllegalTransition(from, to);
}

export function isTerminal(state: EnvironmentState): boolean {
  return TERMINAL.has(state);
}
