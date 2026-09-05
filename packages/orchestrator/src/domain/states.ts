/**
 * The plan and task state machines from baseline section 6, encoded as data so
 * they can be tested as a table and so no handler can invent a transition.
 */

export const PLAN_STATES = [
  'proposed',
  'queued',
  'provisioning',
  'running',
  'finalizing',
  'done',
  'failed',
  'rejected',
  'cancelled',
] as const;

export type PlanState = (typeof PLAN_STATES)[number];

export const TASK_STATES = [
  'pending',
  'ready',
  'dispatched',
  'running',
  'done',
  'failed',
  'cancelled',
] as const;

export type TaskState = (typeof TASK_STATES)[number];

export const TERMINAL_PLAN_STATES: readonly PlanState[] = ['done', 'failed', 'rejected', 'cancelled'];
export const TERMINAL_TASK_STATES: readonly TaskState[] = ['done', 'failed', 'cancelled'];

/**
 * Cancellation is available from every non-terminal plan state, so it is folded
 * in below rather than repeated.
 */
export const PLAN_TRANSITIONS: Readonly<Record<PlanState, readonly PlanState[]>> = {
  proposed: ['queued', 'rejected', 'cancelled'],
  queued: ['provisioning', 'cancelled'],
  // finalizing is reachable directly from provisioning: a validation_failed
  // rejection is terminal and still needs a manifest written.
  provisioning: ['running', 'queued', 'finalizing', 'cancelled'],
  running: ['finalizing', 'cancelled'],
  finalizing: ['done', 'failed', 'cancelled'],
  done: [],
  failed: [],
  rejected: [],
  cancelled: [],
};

export const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  pending: ['ready', 'cancelled'],
  ready: ['dispatched', 'cancelled'],
  // dispatched -> ready is lease expiry; dispatched -> running is the agent's
  // acknowledgement.
  dispatched: ['running', 'ready', 'cancelled'],
  // running -> ready is a failure-policy retry.
  running: ['done', 'failed', 'ready', 'cancelled'],
  done: [],
  failed: [],
  cancelled: [],
};

export class IllegalTransition extends Error {
  readonly code = 'illegal_transition';

  constructor(
    readonly entity: 'plan' | 'task',
    readonly from: string,
    readonly to: string,
  ) {
    super(`${entity} cannot move from ${from} to ${to}`);
    this.name = 'IllegalTransition';
  }
}

export function canPlanTransition(from: PlanState, to: PlanState): boolean {
  return PLAN_TRANSITIONS[from].includes(to);
}

export function canTaskTransition(from: TaskState, to: TaskState): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function assertPlanTransition(from: PlanState, to: PlanState): void {
  if (!canPlanTransition(from, to)) throw new IllegalTransition('plan', from, to);
}

export function assertTaskTransition(from: TaskState, to: TaskState): void {
  if (!canTaskTransition(from, to)) throw new IllegalTransition('task', from, to);
}

export function isPlanTerminal(state: PlanState): boolean {
  return TERMINAL_PLAN_STATES.includes(state);
}

export function isTaskTerminal(state: TaskState): boolean {
  return TERMINAL_TASK_STATES.includes(state);
}
