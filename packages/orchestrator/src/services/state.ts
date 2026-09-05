import type { PoolClient } from 'pg';
import type { Deps } from '../deps.js';
import { recordEvent } from './events.js';
import type { PlanState, TaskState } from '../domain/states.js';

/**
 * Baseline section 6: every state change is an event, written on the same
 * client as the row update so the log can never disagree with the row.
 */

export async function recordPlanStateChange(
  client: PoolClient,
  deps: Deps,
  args: {
    planId: string;
    projectId: string;
    from: PlanState | null;
    to: PlanState;
    reason: string;
  },
): Promise<void> {
  await recordEvent(client, deps, {
    type: 'plan.state_changed',
    severity: args.to === 'failed' ? 'warn' : 'info',
    projectId: args.projectId,
    planId: args.planId,
    payload: { from: args.from, to: args.to, reason: args.reason },
  });
}

export async function recordTaskStateChange(
  client: PoolClient,
  deps: Deps,
  args: {
    planId: string;
    taskId: string;
    from: TaskState | null;
    to: TaskState;
    reason: string;
  },
): Promise<void> {
  await recordEvent(client, deps, {
    type: 'task.state_changed',
    severity: args.to === 'failed' ? 'warn' : 'info',
    planId: args.planId,
    taskId: args.taskId,
    payload: { from: args.from, to: args.to, reason: args.reason },
  });
}

/**
 * A wake-up hint for the dispatcher, nothing more. The periodic tick is the
 * guarantee that work progresses (baseline section 6).
 */
export async function notifyWake(client: PoolClient): Promise<void> {
  await client.query("SELECT pg_notify('mycelium_wake', '')");
}
