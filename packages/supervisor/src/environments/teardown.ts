import { rm } from 'node:fs/promises';
import type { Deps } from '../deps.js';

export type TeardownReason = 'completion' | 'ttl_expired' | 'cancelled' | 'failed';

/** Poll interval while waiting out the grace, so an agent that exits early is not killed. */
const POLL_MS = 100;

/**
 * B15: sandboxes first, then SIGTERM, then SIGKILL five seconds later, uniform
 * across every trigger.
 *
 * The window exists to guarantee a terminal event. A plan that goes silent on
 * cancel or TTL is the case you most need to debug, and silence is the one
 * thing a hard kill cannot fix. Events reach the supervisor's spool over a
 * local socket with no agent-side buffering, so a flush needs milliseconds and
 * five seconds is generous.
 *
 * Every step tolerates its object already being gone. It has to: the
 * orchestrator logs a failed teardown authorization and never retries it, and
 * its client does not even check the status code, so this is called at most
 * once and must not be able to fail.
 */
export async function teardown(
  deps: Deps,
  planId: string,
  reason: TeardownReason,
): Promise<void> {
  const environment = deps.ledger.get(planId);
  if (environment === undefined) return;
  if (environment.state === 'tearing_down') return;

  deps.ledger.transition(planId, 'tearing_down');

  // Sandboxes first and immediately: they are the untrusted tier, they hold
  // the most resources, and nothing they could still be doing is wanted.
  await Promise.all(
    [...environment.sandboxes].map((containerId) =>
      deps.containers.kill(containerId).catch(() => undefined),
    ),
  );
  environment.sandboxes.clear();

  await environment.agent.signal('SIGTERM').catch(() => undefined);

  for (let waited = 0; waited < deps.config.teardownGraceMs; waited += POLL_MS) {
    if (environment.agent.hasExited()) break;
    await deps.sleep(Math.min(POLL_MS, deps.config.teardownGraceMs - waited));
  }

  if (!environment.agent.hasExited()) {
    // The whole process group, so a shell child cannot outlive its parent.
    await environment.agent.signal('SIGKILL').catch(() => undefined);
  }

  await deps.broker.close(planId).catch(() => undefined);
  await deps.proxy.close(planId).catch(() => undefined);
  await deps.containers.removeNetwork(environment.network).catch(() => undefined);
  await rm(environment.root, { recursive: true, force: true }).catch(() => undefined);

  deps.ledger.transition(planId, 'torn_down');
  await deps.events.emit({
    source: 'supervisor',
    type: 'environment.state_changed',
    planId,
    payload: { from: 'tearing_down', to: 'torn_down', reason },
  });

  // Drain once before forgetting the plan, so the agent's terminal event -
  // the whole reason the grace above exists - actually reaches the
  // orchestrator rather than sitting in a spool nobody drains again.
  await deps.flushEvents().catch(() => undefined);

  deps.ledger.remove(planId);
}

/**
 * The supervisor's own TTL, enforced independently of the orchestrator.
 *
 * This is not redundancy for its own sake. `authorizeTeardown` ignores its
 * response status and its caller only logs a throw, so a single dropped
 * authorization would leak an environment until the VM was rebooted. The grace
 * is there so the orchestrator gets first refusal in the normal case.
 */
export async function ttlSweep(deps: Deps): Promise<string[]> {
  const now = deps.clock.now().getTime();
  const graceMs = deps.config.ttlGraceMinutes * 60_000;
  const expired: string[] = [];

  for (const environment of deps.ledger.list()) {
    if (environment.state !== 'running') continue;
    if (now < environment.ttlExpiresAt.getTime() + graceMs) continue;
    expired.push(environment.planId);
  }

  for (const planId of expired) {
    await teardown(deps, planId, 'ttl_expired');
  }

  return expired;
}
