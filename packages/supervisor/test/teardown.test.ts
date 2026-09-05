import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { teardown, ttlSweep } from '../src/environments/teardown.js';
import { buildTestApp, type TestHarness } from './helpers/app.js';
import type { FakeAgentHandle } from './helpers/fakes.js';

let h: TestHarness;
let agent: FakeAgentHandle;

const PLAN_ID = '018f3a5c-0000-7000-8000-00000000000a';

beforeAll(async () => {
  h = await buildTestApp();
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  h.reset();
  agent = h.provisionEnvironment(PLAN_ID);
  await mkdir(path.join(h.stateDir, 'plans', PLAN_ID, 'repo'), { recursive: true });
});

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

describe('teardown - the B15 sequence', () => {
  it('kills the sandboxes before signalling the agent', async () => {
    const environment = h.ledger.get(PLAN_ID);
    environment?.sandboxes.add('container-1');
    environment?.sandboxes.add('container-2');

    await teardown(h.deps, PLAN_ID, 'completion');

    expect(h.containers.killed).toEqual(['container-1', 'container-2']);
    expect(agent.signals[0]).toBe('SIGTERM');
  });

  // The window exists to guarantee a terminal event, not to be waited out.
  it('does not kill an agent that exits on SIGTERM', async () => {
    await teardown(h.deps, PLAN_ID, 'completion');
    expect(agent.signals).toEqual(['SIGTERM']);
  });

  it('kills an agent that ignores SIGTERM once the grace is up', async () => {
    agent.ignoresSigterm = true;

    await teardown(h.deps, PLAN_ID, 'completion');

    expect(agent.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('waits the configured grace and no longer', async () => {
    agent.ignoresSigterm = true;
    const before = h.clock.now().getTime();

    await teardown(h.deps, PLAN_ID, 'completion');

    expect(h.clock.now().getTime() - before).toBe(h.config.teardownGraceMs);
  });

  it('drains the spool once, so the agent\'s terminal event lands', async () => {
    await teardown(h.deps, PLAN_ID, 'completion');
    expect(h.flushes).toHaveLength(1);
  });
});

describe('teardown - what is left behind', () => {
  it('closes the broker socket and the proxy', async () => {
    await teardown(h.deps, PLAN_ID, 'completion');

    expect(h.broker.closed).toContain(PLAN_ID);
    expect(h.proxy.closed).toContain(PLAN_ID);
  });

  it('removes the plan network', async () => {
    await teardown(h.deps, PLAN_ID, 'completion');
    expect(h.containers.removedNetworks).toContain(`mycelium-${PLAN_ID}`);
  });

  it('scrubs the scratch space', async () => {
    const root = path.join(h.stateDir, 'plans', PLAN_ID);
    expect(await exists(root)).toBe(true);

    await teardown(h.deps, PLAN_ID, 'completion');

    expect(await exists(root)).toBe(false);
  });

  it('forgets the environment, freeing the capacity', async () => {
    await teardown(h.deps, PLAN_ID, 'completion');

    expect(h.ledger.has(PLAN_ID)).toBe(false);
    expect(h.ledger.size).toBe(0);
  });

  it('records the reason it was torn down', async () => {
    await teardown(h.deps, PLAN_ID, 'cancelled');

    const event = h.events.ofType('environment.state_changed').at(-1);
    expect(event?.payload).toMatchObject({ to: 'torn_down', reason: 'cancelled' });
  });
});

// The orchestrator logs a failed authorization and never retries it, and its
// client does not check the status code, so this is called at most once and
// must not be able to fail.
describe('teardown - idempotence', () => {
  it('does nothing for a plan this node never had', async () => {
    await expect(teardown(h.deps, 'never-heard-of-it', 'cancelled')).resolves.toBeUndefined();
  });

  it('is a no-op the second time', async () => {
    await teardown(h.deps, PLAN_ID, 'completion');
    await teardown(h.deps, PLAN_ID, 'completion');

    expect(agent.signals).toEqual(['SIGTERM']);
    expect(h.flushes).toHaveLength(1);
  });

  it('finishes even when every step fails', async () => {
    h.containers.kill = async () => {
      throw new Error('docker is gone');
    };
    h.containers.removeNetwork = async () => {
      throw new Error('docker is gone');
    };
    agent.signal = async () => {
      throw new Error('no such process');
    };
    h.ledger.get(PLAN_ID)?.sandboxes.add('container-1');

    await teardown(h.deps, PLAN_ID, 'failed');

    expect(h.ledger.has(PLAN_ID)).toBe(false);
  });
});

describe('POST /plans/:id/teardown', () => {
  it('always answers 204, so the authorization cannot fail', async () => {
    const response = await h.inject({
      method: 'POST',
      url: `/plans/${PLAN_ID}/teardown`,
      payload: { reason: 'completion' },
    });

    expect(response.statusCode).toBe(204);
    expect(h.ledger.has(PLAN_ID)).toBe(false);
  });

  it('answers 204 for a plan it is not running', async () => {
    const response = await h.inject({
      method: 'POST',
      url: '/plans/018f3a5c-0000-7000-8000-0000000000ff/teardown',
      payload: { reason: 'cancelled' },
    });
    expect(response.statusCode).toBe(204);
  });

  it('carries the reason into the event', async () => {
    await h.inject({
      method: 'POST',
      url: `/plans/${PLAN_ID}/teardown`,
      payload: { reason: 'ttl_expired' },
    });

    expect(h.events.ofType('environment.state_changed').at(-1)?.payload).toMatchObject({
      reason: 'ttl_expired',
    });
  });
});

// This exists because authorizeTeardown ignores its response status and its
// caller only logs a throw: one dropped authorization would otherwise leak an
// environment until the VM was rebooted.
describe('the TTL backstop', () => {
  it('leaves an environment inside its TTL alone', async () => {
    h.clock.advance(239 * 60_000);
    expect(await ttlSweep(h.deps)).toEqual([]);
    expect(h.ledger.has(PLAN_ID)).toBe(true);
  });

  it('gives the orchestrator first refusal for the grace period', async () => {
    h.clock.advance((240 + 4) * 60_000);
    expect(await ttlSweep(h.deps)).toEqual([]);
  });

  it('tears down once the TTL and its grace have both passed', async () => {
    h.clock.advance((240 + 6) * 60_000);

    expect(await ttlSweep(h.deps)).toEqual([PLAN_ID]);
    expect(h.ledger.has(PLAN_ID)).toBe(false);
  });

  it('records it as a TTL expiry rather than a completion', async () => {
    h.clock.advance((240 + 6) * 60_000);
    await ttlSweep(h.deps);

    expect(h.events.ofType('environment.state_changed').at(-1)?.payload).toMatchObject({
      reason: 'ttl_expired',
    });
  });
});
