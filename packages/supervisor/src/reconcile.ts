import path from 'node:path';
import { rm } from 'node:fs/promises';
import type { Deps } from './deps.js';
import { listRecordedPlans, readRecord, type EnvironmentRecord } from './environments/record.js';

export interface ReconcileResult {
  /** True once sequence numbers may be issued again. */
  armed: boolean;
  killedContainers: string[];
  killedAgents: string[];
  /** Plans whose agent answered and was taken back over. */
  adopted: string[];
}

/**
 * Startup reconciliation, run before the daemon listens.
 *
 * Ticket 0003 adopted nothing and killed everything, because re-attaching meant
 * agreeing a resumption contract with a component nobody had written. Now that
 * the plan agent exists the contract turned out to be small, because the agent
 * reports task status to the orchestrator directly: it never noticed the
 * supervisor was gone, and the only thing a restart actually breaks is this
 * process's ability to hand it the *next* task. A live socket and a restored
 * ledger entry is the whole of that.
 *
 * Adoption is still deliberately conservative. A plan is taken back only if the
 * orchestrator still places it here, its record is intact, and its agent
 * answers naming that plan. Anything short of all three is killed, because a
 * plan that looks alive and answers nothing is worse than one that failed
 * cleanly.
 *
 * The ordering matters and is unchanged. Sequence numbers cannot be issued
 * until recovery has taken the higher of the spool's marks and the
 * orchestrator's, so nothing here may emit an event before `arm` has been
 * called. When the orchestrator is unreachable the daemon still cleans the VM,
 * but it stays unarmed and the caller retries — a supervisor that guessed a
 * sequence number would be reporting an emitter bug it caused itself.
 */
export async function reconcile(
  deps: Deps,
  arm: (marks: Array<{ stream_id: string; seq: number }>) => void,
): Promise<ReconcileResult> {
  let armed = false;
  let assigned = new Set<string>();

  try {
    const assignments = await deps.orchestrator.assignments();
    arm(assignments.high_water_marks);
    armed = true;
    assigned = new Set(assignments.plans.map((plan) => plan.plan_id));
  } catch (error) {
    deps.log?.warn?.(
      { err: error },
      'could not reach the orchestrator; cleaning the node without adopting anything',
    );
  }

  // Discovery starts from disk, not from the process table: after a restart
  // this process started none of these, so it holds no handles to find them by.
  const recorded = await listRecordedPlans(deps.config.stateDir);
  const adopted: string[] = [];
  const killedAgents: string[] = [];

  for (const planId of recorded) {
    const root = path.join(deps.config.stateDir, 'plans', planId);
    const record = await readRecord(root);

    if (record === null || !assigned.has(planId)) {
      await discard(deps, planId, root, record);
      killedAgents.push(planId);
      continue;
    }

    const agent = await deps.agents.probe(planId, record.dispatch_socket).catch(() => null);
    if (agent === null) {
      await discard(deps, planId, root, record);
      killedAgents.push(planId);
      continue;
    }

    // The broker and the proxy were this process's listeners and died with it.
    // The agent on the other side reconnects per call, so re-opening them is
    // enough — there is no session to restore.
    await deps.broker.listen(planId, record.broker_socket);
    const proxy = await deps.proxy.listen(planId, record.gateway_address);

    deps.ledger.add({
      planId,
      state: 'running',
      root: record.root,
      workdir: record.workdir,
      agent,
      network: record.network,
      proxyUrl: proxy.url,
      brokerSocket: record.broker_socket,
      egress: record.egress,
      ttlExpiresAt: new Date(record.ttl_expires_at),
      // Sandboxes are re-attached below, once the surviving ones are known.
      sandboxes: new Set(),
    });

    adopted.push(planId);
  }

  // A sandbox belonging to an adopted plan survives: its agent is still waiting
  // on it, and killing it would fail a task that was about to succeed.
  const containers = await deps.containers.listContainers().catch(() => []);
  const killedContainers: string[] = [];

  for (const container of containers) {
    const environment = deps.ledger.get(container.planId);
    if (environment !== undefined) {
      environment.sandboxes.add(container.containerId);
      continue;
    }
    await deps.containers.kill(container.containerId).catch(() => undefined);
    killedContainers.push(container.containerId);
  }

  // Agents this process somehow still holds, or that left a scope behind with
  // no record at all.
  for (const planId of await deps.agents.listRunning().catch(() => [])) {
    if (adopted.includes(planId) || killedAgents.includes(planId)) continue;
    await deps.agents.kill(planId).catch(() => undefined);
    await deps.containers.removeNetwork(`mycelium-${planId}`).catch(() => undefined);
    killedAgents.push(planId);
  }

  // Only now, and only if the stream is armed.
  if (armed) {
    for (const planId of adopted) {
      await deps.events.emit({
        source: 'supervisor',
        type: 'environment.state_changed',
        planId,
        payload: { from: 'running', to: 'running', reason: 'readopted_after_restart' },
      });
    }

    for (const planId of killedAgents) {
      await deps.events.emit({
        source: 'supervisor',
        type: 'environment.state_changed',
        severity: 'warn',
        planId,
        payload: {
          from: 'running',
          to: 'torn_down',
          reason: 'orphan_after_restart',
          containers_killed: killedContainers.length,
        },
      });
    }
  }

  return { armed, killedContainers, killedAgents, adopted };
}

/** Everything tolerates its object never having existed; a restart finds partial state. */
async function discard(
  deps: Deps,
  planId: string,
  root: string,
  record: EnvironmentRecord | null,
): Promise<void> {
  await deps.agents.kill(planId).catch(() => undefined);
  await deps.containers.removeNetwork(record?.network ?? `mycelium-${planId}`).catch(() => undefined);
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}
