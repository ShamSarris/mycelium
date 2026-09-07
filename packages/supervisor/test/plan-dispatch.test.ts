import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CloneError } from '../src/drivers/git.js';
import { teardown } from '../src/environments/teardown.js';
import { buildTestApp, planDispatch, type TestHarness } from './helpers/app.js';

let h: TestHarness;

const PLAN_ID = '018f3a5c-0000-7000-8000-00000000000a';

beforeAll(async () => {
  h = await buildTestApp();
});

afterAll(async () => {
  await h.close();
});

beforeEach(() => {
  h.reset();
});

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

describe('POST /plans - accepting a plan', () => {
  it('accepts and reports it the way the orchestrator client expects', async () => {
    const response = await h.dispatch();

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: true });
  });

  it('clones the project repo at the plan branch with the bot token', async () => {
    await h.dispatch();

    expect(h.git.clones).toHaveLength(1);
    expect(h.git.clones[0]).toMatchObject({
      repoUrl: 'http://gitea.tailnet/mycelium/demo.git',
      branch: `plan/${PLAN_ID}`,
      token: 'gitea-bot-token',
    });
    expect(h.git.clones[0]?.dir).toContain(PLAN_ID);
  });

  it('creates the plan an internal network with no route out', async () => {
    await h.dispatch();
    expect(h.containers.networks.get(PLAN_ID)).toBe(`mycelium-${PLAN_ID}`);
  });

  it('starts the agent with the three per-plan credentials and its own workdir', async () => {
    await h.dispatch();

    const [spec] = h.agents.started;
    expect(spec?.planId).toBe(PLAN_ID);
    expect(spec?.env).toMatchObject({
      PLAN_ID,
      ORCHESTRATOR_URL: 'http://orchestrator.tailnet:8080',
      ORCHESTRATOR_TOKEN: 'per-plan-token',
      GITEA_BOT_TOKEN: 'gitea-bot-token',
    });
    expect(spec?.cwd).toBe(spec?.env.WORKDIR);
  });

  // Ticket 15: the Agent SDK spawns a `claude` subprocess that needs a
  // writable config directory and an isolated HOME, and B13 means these must
  // be deliberately injected rather than inherited.
  it('gives the agent SDK an isolated HOME and CLAUDE_CONFIG_DIR inside the plan run directory', async () => {
    await h.dispatch();

    const [spec] = h.agents.started;
    const runDir = path.join(h.stateDir, 'plans', PLAN_ID, 'run');
    expect(spec?.env.HOME).toBe(runDir);
    expect(spec?.env.CLAUDE_CONFIG_DIR).toBe(path.join(runDir, '.claude'));
  });

  // Ticket 13/15: the operator-authored plan cannot know what the VM can
  // take, so the number is derived from the supervisor's own memory ceiling
  // rather than carried on the dispatch.
  it('derives MAX_CONCURRENT_SUBAGENTS instead of carrying MAX_CONCURRENT_AGENTS', async () => {
    await h.dispatch();

    const [spec] = h.agents.started;
    // No AGENT_MEMORY_MAX_BYTES configured in this harness, so this is
    // deriveMaxConcurrentSubagents's CONSERVATIVE_DEFAULT_WHEN_UNBOUNDED.
    expect(spec?.env.MAX_CONCURRENT_SUBAGENTS).toBe('2');
    expect(spec?.env).not.toHaveProperty('MAX_CONCURRENT_AGENTS');
  });

  it('derives MAX_CONCURRENT_SUBAGENTS from AGENT_MEMORY_MAX_BYTES when the supervisor has one configured', async () => {
    const h2 = await buildTestApp({ agentMemoryMaxBytes: 3 * 1024 ** 3 });
    try {
      await h2.dispatch();
      const [spec] = h2.agents.started;
      // 3 GiB ceiling - 1 GiB parent reserve, at ~1 GiB/subagent = 2.
      expect(spec?.env.MAX_CONCURRENT_SUBAGENTS).toBe('2');
    } finally {
      await h2.close();
    }
  });

  it('takes the model key from the secret helper, never from its own environment', async () => {
    await h.dispatch();
    expect(h.agents.started[0]?.env.MODEL_API_KEY).toBe('secret-model_api_key');
  });

  it('points the agent at the broker socket and its own dispatch socket', async () => {
    await h.dispatch();

    const [spec] = h.agents.started;
    expect(spec?.brokerSocket).toBeTruthy();
    expect(spec?.dispatchSocket).toBeTruthy();
    expect(spec?.brokerSocket).not.toBe(spec?.dispatchSocket);
    expect(spec?.env.AGENT_SOCKET).toBe(spec?.brokerSocket);
  });

  it('registers the environment with its TTL and its resolved egress list', async () => {
    await h.dispatch();

    const environment = h.ledger.get(PLAN_ID);
    expect(environment?.state).toBe('running');
    expect(environment?.ttlExpiresAt.toISOString()).toBe(
      new Date(h.clock.now().getTime() + 240 * 60_000).toISOString(),
    );
    // The standing set plus what the plan declared, resolved once.
    expect(environment?.egress).toContain('api.github.com');
    expect(environment?.egress).toContain('registry.npmjs.org');
  });

  it('records the environment coming up', async () => {
    await h.dispatch();

    const [event] = h.events.ofType('environment.state_changed');
    expect(event?.planId).toBe(PLAN_ID);
    expect(event?.payload).toMatchObject({ to: 'running' });
  });

  it('never writes a credential into an event payload', async () => {
    await h.dispatch();
    const serialised = JSON.stringify(h.events.events);
    expect(serialised).not.toContain('per-plan-token');
    expect(serialised).not.toContain('gitea-bot-token');
    expect(serialised).not.toContain('secret-model_api_key');
  });
});

describe('POST /plans - idempotency', () => {
  // Placement is sticky, so the plan id is a sufficient key. The dispatch
  // carries no dispatch_id (ticket 0003 section 13).
  it('returns accepted without provisioning twice', async () => {
    await h.dispatch();
    const second = await h.dispatch();

    expect(second.statusCode).toBe(202);
    expect(second.json()).toEqual({ accepted: true });
    expect(h.git.clones).toHaveLength(1);
    expect(h.agents.started).toHaveLength(1);
  });
});

describe('POST /plans - capacity (B21)', () => {
  it('refuses at the configured cap, in the shape the client parses', async () => {
    await h.dispatch();
    await h.dispatch({ payload: planDispatch({ plan_id: crypto.randomUUID() }) });

    const third = await h.dispatch({ payload: planDispatch({ plan_id: crypto.randomUUID() }) });

    expect(third.statusCode).toBe(429);
    expect(third.json().code).toBe('capacity_exceeded');
  });

  it('leaves no trace of the plan it refused', async () => {
    await h.dispatch();
    await h.dispatch({ payload: planDispatch({ plan_id: crypto.randomUUID() }) });

    const refusedId = crypto.randomUUID();
    await h.dispatch({ payload: planDispatch({ plan_id: refusedId }) });

    expect(h.ledger.has(refusedId)).toBe(false);
    expect(h.git.clones).toHaveLength(2);
  });
});

describe('POST /plans - terminal rejections', () => {
  // validation_failed is terminal orchestrator-side: it fails the plan rather
  // than trying the next VM, because the next VM would fail identically.
  it('refuses a dispatch missing its plan id', async () => {
    const response = await h.dispatch({ payload: planDispatch({ plan_id: undefined }) });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('validation_failed');
  });

  it('refuses a dispatch with no gitea branch to check out', async () => {
    const response = await h.dispatch({
      payload: planDispatch({
        gitea: { repo_url: 'http://gitea.tailnet/mycelium/demo.git', bot_token: 't' },
      }),
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses an egress entry the plan schema would not have allowed', async () => {
    const response = await h.dispatch({ payload: planDispatch({ egress: ['not a host'] }) });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('validation_failed');
  });

  it('refuses a bare wildcard, which would be an unrestricted mode (B14)', async () => {
    const response = await h.dispatch({ payload: planDispatch({ egress: ['*'] }) });
    expect(response.statusCode).toBe(400);
  });

  it('accepts a subdomain wildcard, which the plan schema does allow', async () => {
    const response = await h.dispatch({ payload: planDispatch({ egress: ['*.example.com'] }) });
    expect(response.statusCode).toBe(202);
  });

  it('accepts a dispatch carrying no concurrency figure at all', async () => {
    // `max_concurrent_agents` left the plan schema with ticket 03 and left
    // the wire with this change. It was still *required* here — validated
    // 1..4 — long after this process stopped reading it: the supervisor
    // derives its own subagent ceiling from the memory it alone can see
    // (`domain/concurrency.ts`), so an operator-authored figure has had no
    // effect on anything since ticket 13.
    const response = await h.dispatch({ payload: planDispatch() });
    expect(response.statusCode).toBe(202);
  });

  it('ignores a concurrency figure an older orchestrator still sends', async () => {
    // Forward compatibility in the one direction that matters: the wire
    // change lands in both processes at once, but a stale orchestrator that
    // still sends the field must not be rejected over a value nothing reads.
    const response = await h.dispatch({ payload: planDispatch({ max_concurrent_agents: 9 }) });
    expect(response.statusCode).toBe(202);
  });

  // The orchestrator created plan/<id> at approval, so its absence is a bug
  // rather than a race, and no other VM would fare better.
  it('treats a missing branch as terminal, not as a reason to try elsewhere', async () => {
    h.git.failWith = new CloneError('missing_branch', 'no such ref');
    const response = await h.dispatch();

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('validation_failed');
  });

  it('treats a missing repo as terminal', async () => {
    h.git.failWith = new CloneError('missing_repo', 'not found');
    expect((await h.dispatch()).statusCode).toBe(400);
  });
});

describe('POST /plans - retryable failures', () => {
  // This VM's problem. The orchestrator should look at the next candidate,
  // which is what turns first-fit into failover (B12).
  it('reports a transient clone failure as capacity, so the next VM is tried', async () => {
    h.git.failWith = new CloneError('transient', 'connection reset');
    const response = await h.dispatch();

    expect(response.statusCode).toBe(429);
    expect(response.json().code).toBe('capacity_exceeded');
  });

  it('reports a network failure the same way', async () => {
    h.containers.failNetwork = new Error('docker daemon is not running');
    expect((await h.dispatch()).statusCode).toBe(429);
  });

  it('reports an agent that will not start the same way', async () => {
    h.agents.failNext = new Error('cgroup delegation denied');
    expect((await h.dispatch()).statusCode).toBe(429);
  });
});

describe('POST /plans - cleanup after a partial provision', () => {
  it('leaves no ledger entry when the agent fails to start', async () => {
    h.agents.failNext = new Error('cgroup delegation denied');
    await h.dispatch();

    expect(h.ledger.has(PLAN_ID)).toBe(false);
    expect(h.ledger.size).toBe(0);
  });

  it('removes the network it had already created', async () => {
    h.agents.failNext = new Error('cgroup delegation denied');
    await h.dispatch();

    expect(h.containers.removedNetworks).toContain(`mycelium-${PLAN_ID}`);
  });

  it('removes the directory it had already made, so a retry starts clean', async () => {
    h.agents.failNext = new Error('cgroup delegation denied');
    await h.dispatch();

    expect(await exists(path.join(h.stateDir, 'plans', PLAN_ID))).toBe(false);
  });

  it('records the failure', async () => {
    h.agents.failNext = new Error('cgroup delegation denied');
    await h.dispatch();

    const events = h.events.ofType('environment.state_changed');
    expect(events.at(-1)?.payload).toMatchObject({ to: 'failed' });
  });

  it('can be dispatched again after a failure', async () => {
    h.agents.failNext = new Error('cgroup delegation denied');
    await h.dispatch();

    const second = await h.dispatch();
    expect(second.statusCode).toBe(202);
    expect(h.ledger.has(PLAN_ID)).toBe(true);
    expect(await exists(path.join(h.stateDir, 'plans', PLAN_ID, 'repo'))).toBe(true);
  });
});

describe('POST /plans - the environment on disk', () => {
  it('makes the checkout directory the agent was told to work in', async () => {
    await h.dispatch();

    const root = path.join(h.stateDir, 'plans', PLAN_ID);
    expect(await exists(path.join(root, 'repo'))).toBe(true);
    expect(await exists(path.join(root, 'run'))).toBe(true);
    expect(await readdir(path.join(h.stateDir, 'plans'))).toContain(PLAN_ID);
  });

  // Ticket 15: the SDK may not create CLAUDE_CONFIG_DIR itself, so
  // provisioning does — and it must be gone afterwards, or it is a slow disk
  // leak, one per plan, forever.
  it('creates the per-plan Claude config directory', async () => {
    await h.dispatch();

    const claudeDir = path.join(h.stateDir, 'plans', PLAN_ID, 'run', '.claude');
    expect(await exists(claudeDir)).toBe(true);
  });

  it('removes the Claude config directory on teardown', async () => {
    await h.dispatch();
    const claudeDir = path.join(h.stateDir, 'plans', PLAN_ID, 'run', '.claude');
    expect(await exists(claudeDir)).toBe(true);

    await teardown(h.deps, PLAN_ID, 'completion');

    expect(await exists(claudeDir)).toBe(false);
  });
});
