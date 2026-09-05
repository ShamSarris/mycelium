import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { reconcile } from '../src/reconcile.js';
import { writeRecord, type EnvironmentRecord } from '../src/environments/record.js';
import { ttlSweep } from '../src/environments/teardown.js';
import { buildTestApp, type TestHarness } from './helpers/app.js';

/**
 * Restart reconciliation, which ticket 0003 deferred because re-attaching
 * meant agreeing a resumption contract with a plan agent nobody had written.
 *
 * The contract turned out to be small. The agent reports task status to the
 * orchestrator directly, so it never noticed this process was gone; the only
 * thing a restart breaks is the ability to hand it the next task. What these
 * tests hold is the conservatism around that: three conditions must all be
 * true before a plan is taken back, because a plan that looks alive and
 * answers nothing is worse than one that failed cleanly.
 */

let h: TestHarness;

const PLAN_ID = '018f3a5c-0000-7000-8000-00000000000a';

beforeAll(async () => {
  h = await buildTestApp();
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  h.reset();
  // A real restart starts with an empty ledger; the harness's convenience
  // helper is deliberately not used here.
  for (const environment of h.ledger.list()) h.ledger.remove(environment.planId);
});

function root(planId = PLAN_ID): string {
  return path.join(h.stateDir, 'plans', planId);
}

/** An environment on disk, as provisioning would have left it. */
async function recordFor(
  planId = PLAN_ID,
  overrides: Partial<EnvironmentRecord> = {},
): Promise<EnvironmentRecord> {
  const base = root(planId);
  const record: EnvironmentRecord = {
    plan_id: planId,
    root: base,
    workdir: path.join(base, 'repo'),
    network: `mycelium-${planId}`,
    gateway_address: '172.20.0.1',
    broker_socket: path.join(base, 'run', 'broker.sock'),
    dispatch_socket: path.join(base, 'run', 'dispatch.sock'),
    egress: ['gitea.tailnet', 'api.github.com'],
    ttl_expires_at: new Date(h.clock.now().getTime() + 240 * 60_000).toISOString(),
    ...overrides,
  };
  await mkdir(path.join(base, 'repo'), { recursive: true });
  await writeRecord(record);
  return record;
}

function assigns(...planIds: string[]): void {
  h.orchestrator.assignmentsResponse = {
    plans: planIds.map((plan_id) => ({ plan_id, state: 'running', project_id: 'p' })),
    high_water_marks: [],
  };
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

describe('the environment record', () => {
  it('is written by provisioning and carries what the ledger needs', async () => {
    await h.dispatch();

    const record = JSON.parse(
      await (await import('node:fs/promises')).readFile(
        path.join(root(), 'run', 'environment.json'),
        'utf8',
      ),
    ) as EnvironmentRecord;

    expect(record.plan_id).toBe(PLAN_ID);
    expect(record.egress).toContain('api.github.com');
    expect(record.network).toBeTruthy();
    expect(record.dispatch_socket).toContain('dispatch.sock');
    expect(new Date(record.ttl_expires_at).getTime()).toBeGreaterThan(h.clock.now().getTime());
  });

  it('holds no secrets', async () => {
    await h.dispatch();

    const raw = await (await import('node:fs/promises')).readFile(
      path.join(root(), 'run', 'environment.json'),
      'utf8',
    );

    // The agent already holds these; writing them here would put three
    // credentials on disk for the life of the VM and buy nothing.
    expect(raw).not.toContain('gitea-bot-token');
    expect(raw).not.toContain('per-plan-token');
    expect(raw).not.toContain('model_api_key');
  });
});

describe('adoption', () => {
  it('takes back a plan the orchestrator still holds whose agent answers', async () => {
    await recordFor();
    assigns(PLAN_ID);
    h.agents.answering.add(PLAN_ID);

    const result = await reconcile(h.deps, () => undefined);

    expect(result.adopted).toEqual([PLAN_ID]);
    expect(h.agents.killed).toHaveLength(0);
  });

  it('restores the ledger entry from the record, not from the orchestrator', async () => {
    await recordFor();
    assigns(PLAN_ID);
    h.agents.answering.add(PLAN_ID);

    await reconcile(h.deps, () => undefined);

    // None of this is in the assignments response, which is the whole reason
    // the record exists.
    const environment = h.ledger.get(PLAN_ID);
    expect(environment?.egress).toEqual(['gitea.tailnet', 'api.github.com']);
    expect(environment?.network).toBe(`mycelium-${PLAN_ID}`);
    expect(environment?.workdir).toContain('repo');
  });

  it('re-opens the broker socket and the proxy, which died with the old process', async () => {
    const record = await recordFor();
    assigns(PLAN_ID);
    h.agents.answering.add(PLAN_ID);

    await reconcile(h.deps, () => undefined);

    expect(h.broker.listening.get(PLAN_ID)).toBe(record.broker_socket);
    expect(h.proxy.listening.has(PLAN_ID)).toBe(true);
  });

  it('probes the socket the record names', async () => {
    const record = await recordFor();
    assigns(PLAN_ID);
    h.agents.answering.add(PLAN_ID);

    await reconcile(h.deps, () => undefined);

    expect(h.agents.probed).toEqual([{ planId: PLAN_ID, socket: record.dispatch_socket }]);
  });

  it('says so as an event', async () => {
    await recordFor();
    assigns(PLAN_ID);
    h.agents.answering.add(PLAN_ID);

    await reconcile(h.deps, () => undefined);

    expect(h.events.ofType('environment.state_changed').at(-1)?.payload).toMatchObject({
      reason: 'readopted_after_restart',
    });
  });

  it('keeps enforcing the TTL from the persisted expiry', async () => {
    await recordFor();
    assigns(PLAN_ID);
    h.agents.answering.add(PLAN_ID);
    await reconcile(h.deps, () => undefined);

    h.clock.advance((240 + 6) * 60_000);

    // An adopted plan whose TTL stopped being enforced would leak the
    // environment until the VM was rebooted.
    expect(await ttlSweep(h.deps)).toEqual([PLAN_ID]);
  });
});

describe('what it refuses to adopt', () => {
  it('kills a plan whose agent does not answer', async () => {
    await recordFor();
    assigns(PLAN_ID);
    // h.agents.answering is empty: the socket is dead.

    const result = await reconcile(h.deps, () => undefined);

    expect(result.adopted).toEqual([]);
    expect(h.agents.killed).toContain(PLAN_ID);
    expect(h.ledger.has(PLAN_ID)).toBe(false);
    expect(await exists(root())).toBe(false);
  });

  it('kills a plan the orchestrator no longer places here, even if it answers', async () => {
    await recordFor();
    assigns(); // the orchestrator has moved on
    h.agents.answering.add(PLAN_ID);

    const result = await reconcile(h.deps, () => undefined);

    expect(result.adopted).toEqual([]);
    expect(h.agents.killed).toContain(PLAN_ID);
  });

  it('kills a plan whose record is corrupt, rather than guessing at it', async () => {
    await mkdir(path.join(root(), 'run'), { recursive: true });
    await writeFile(path.join(root(), 'run', 'environment.json'), '{ half-writ', 'utf8');
    assigns(PLAN_ID);
    h.agents.answering.add(PLAN_ID);

    const result = await reconcile(h.deps, () => undefined);

    // A half-written record from a crash mid-provision would adopt a plan into
    // an environment that was never finished.
    expect(result.adopted).toEqual([]);
    expect(h.agents.killed).toContain(PLAN_ID);
  });

  it('adopts nothing when the orchestrator is unreachable, and stays unarmed', async () => {
    await recordFor();
    h.orchestrator.assignmentsThrows = true;
    h.agents.answering.add(PLAN_ID);

    const result = await reconcile(h.deps, () => undefined);

    // A supervisor that guessed a sequence number would be reporting an
    // emitter bug it had caused itself.
    expect(result.armed).toBe(false);
    expect(result.adopted).toEqual([]);
    expect(h.agents.killed).toContain(PLAN_ID);
    expect(h.events.events).toHaveLength(0);
  });

  it('reports each orphan it killed', async () => {
    await recordFor();
    assigns(PLAN_ID);

    await reconcile(h.deps, () => undefined);

    const event = h.events.ofType('environment.state_changed').at(-1);
    expect(event?.planId).toBe(PLAN_ID);
    expect(event?.payload).toMatchObject({ reason: 'orphan_after_restart' });
  });

  it('kills an agent it finds with no record at all', async () => {
    assigns();
    h.agents.orphans = ['orphan-plan'];

    const result = await reconcile(h.deps, () => undefined);

    expect(h.agents.killed).toContain('orphan-plan');
    expect(h.containers.removedNetworks).toContain('mycelium-orphan-plan');
    expect(result.killedAgents).toContain('orphan-plan');
  });
});

describe('sandboxes', () => {
  it('leaves an adopted plan is containers alone and re-attaches them', async () => {
    await recordFor();
    assigns(PLAN_ID);
    h.agents.answering.add(PLAN_ID);
    h.containers.existing = [{ containerId: 'still-building', planId: PLAN_ID }];

    const result = await reconcile(h.deps, () => undefined);

    // The agent is still waiting on this one; killing it would fail a task
    // that was about to succeed.
    expect(h.containers.killed).toEqual([]);
    expect(result.killedContainers).toEqual([]);
    expect(h.ledger.get(PLAN_ID)?.sandboxes.has('still-building')).toBe(true);
  });

  it('kills a container belonging to nothing it adopted', async () => {
    assigns();
    h.containers.existing = [
      { containerId: 'left-over-1', planId: 'gone' },
      { containerId: 'left-over-2', planId: 'gone' },
    ];

    const result = await reconcile(h.deps, () => undefined);

    expect(h.containers.killed).toEqual(['left-over-1', 'left-over-2']);
    expect(result.killedContainers).toHaveLength(2);
  });
});

describe('arming', () => {
  it('arms the event stream from the orchestrator marks', async () => {
    h.orchestrator.assignmentsResponse = {
      plans: [],
      high_water_marks: [{ stream_id: 'supervisor:node-1', seq: 12 }],
    };
    const armed: Array<{ stream_id: string; seq: number }> = [];

    const result = await reconcile(h.deps, (marks) => armed.push(...marks));

    expect(result.armed).toBe(true);
    expect(armed).toEqual([{ stream_id: 'supervisor:node-1', seq: 12 }]);
  });

  it('emits nothing before arming', async () => {
    await recordFor();
    h.orchestrator.assignmentsThrows = true;

    await reconcile(h.deps, () => undefined);

    expect(h.events.events).toHaveLength(0);
  });
});
