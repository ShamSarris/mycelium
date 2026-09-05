import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tick } from '../src/services/dispatcher.js';
import type { PlanManifest } from '../src/services/finalize.js';
import { buildTestApp, bearer, operatorHeaders, type TestHarness } from './helpers/app.js';
import {
  heartbeat,
  planState,
  runningPlan,
  singleTaskPlan,
  taskState,
  validPlan,
  type RunningPlan,
} from './helpers/fixtures.js';

let h: TestHarness;

beforeAll(async () => {
  h = await buildTestApp();
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await h.reset();
});

async function manifestOf(planId: string): Promise<PlanManifest | null> {
  const { rows } = await h.pool.query<{ manifest: PlanManifest | null }>(
    'SELECT manifest FROM plans WHERE id = $1',
    [planId],
  );
  return rows[0]?.manifest ?? null;
}

async function completeTheTask(running: RunningPlan, tokens = 1200): Promise<void> {
  const taskId = running.taskIds['only'] as string;
  for (const state of ['running', 'done']) {
    await h.app.inject({
      method: 'POST',
      url: `/plans/${running.planId}/tasks/${taskId}/status`,
      headers: bearer(running.planToken),
      payload: state === 'done' ? { state, tokens_spent: tokens } : { state },
    });
  }
}

describe('a plan whose criteria pass', () => {
  it('opens the pull request and marks the plan done', async () => {
    const running = await runningPlan(h, singleTaskPlan());
    await completeTheTask(running);
    await tick(h.deps);

    expect(await planState(h, running.planId)).toBe('done');
    expect(h.gitea.openPullRequestCalls).toEqual([
      { repo: 'demo', head: `plan/${running.planId}` },
    ]);
  });

  it('writes a manifest naming the head, the pull request, and the spend', async () => {
    const running = await runningPlan(h, singleTaskPlan());
    await completeTheTask(running, 4200);
    h.clock.advanceMinutes(3);
    await heartbeat(h, running.supervisor.id);
    await tick(h.deps);

    const manifest = await manifestOf(running.planId);
    expect(manifest).toMatchObject({
      head_sha: 'a1b2c3d4e5f6',
      pr_url: 'http://gitea.local/mycelium/demo/pulls/1',
      criteria: [{ type: 'all_tasks_done', passed: true }],
      tokens_spent: 4200,
      terminal_reason: null,
    });
    expect(manifest?.wall_clock_ms).toBe(3 * 60_000);
  });

  it('revokes the bot user and destroys the per-plan token', async () => {
    const running = await runningPlan(h, singleTaskPlan());
    await completeTheTask(running);
    await tick(h.deps);

    expect(h.gitea.revokeCalls).toHaveLength(1);
    expect(h.deps.tokens.get(running.planId)).toBeUndefined();

    const { rows } = await h.pool.query<{ agent_token_hash: string | null }>(
      'SELECT agent_token_hash FROM plans WHERE id = $1',
      [running.planId],
    );
    expect(rows[0]?.agent_token_hash).toBeNull();
  });

  it('authorises teardown with the completion reason', async () => {
    const running = await runningPlan(h, singleTaskPlan());
    await completeTheTask(running);
    await tick(h.deps);

    expect(h.supervisors.teardowns).toEqual([
      { agentId: running.supervisor.id, planId: running.planId, reason: 'completion' },
    ]);
  });

  it('sums the spend across every task', async () => {
    const plan = {
      ...validPlan(),
      max_concurrent_agents: 2,
      tasks: [
        { id: 'a', description: 'one', limits: { tokens: 100, wall_clock_min: 5 } },
        { id: 'b', description: 'two', limits: { tokens: 100, wall_clock_min: 5 } },
      ],
    };
    const running = await runningPlan(h, plan);

    for (const [local, tokens] of [
      ['a', 30],
      ['b', 70],
    ] as const) {
      const url = `/plans/${running.planId}/tasks/${running.taskIds[local]}/status`;
      await h.app.inject({ method: 'POST', url, headers: bearer(running.planToken), payload: { state: 'running' } });
      await h.app.inject({
        method: 'POST',
        url,
        headers: bearer(running.planToken),
        payload: { state: 'done', tokens_spent: tokens },
      });
    }

    await tick(h.deps);
    expect((await manifestOf(running.planId))?.tokens_spent).toBe(100);
  });
});

describe('a plan whose criteria fail', () => {
  it('fails the plan but still opens the pull request', async () => {
    h.gitea.fileExistsResult = false;
    const running = await runningPlan(h, {
      ...singleTaskPlan(),
      success_criteria: [{ type: 'file_exists_in_branch', path: 'docs/report.md' }],
    });
    await completeTheTask(running);
    await tick(h.deps);

    expect(await planState(h, running.planId)).toBe('failed');
    expect(h.gitea.openPullRequestCalls).toHaveLength(1);

    const manifest = await manifestOf(running.planId);
    expect(manifest?.criteria).toEqual([
      { type: 'file_exists_in_branch', path: 'docs/report.md', passed: false },
    ]);
  });

  it('checks the file on the plan branch, not on main', async () => {
    const running = await runningPlan(h, {
      ...singleTaskPlan(),
      success_criteria: [{ type: 'file_exists_in_branch', path: 'out.json' }],
    });
    await completeTheTask(running);
    await tick(h.deps);

    expect(h.gitea.fileExistsCalls).toEqual([
      { repo: 'demo', branch: `plan/${running.planId}`, path: 'out.json' },
    ]);
  });

  it('authorises teardown with the failed reason', async () => {
    h.gitea.fileExistsResult = false;
    const running = await runningPlan(h, {
      ...singleTaskPlan(),
      success_criteria: [{ type: 'file_exists_in_branch', path: 'missing.md' }],
    });
    await completeTheTask(running);
    await tick(h.deps);

    expect(h.supervisors.teardowns[0]?.reason).toBe('failed');
  });

  it('records a null pull request url when nothing was pushed', async () => {
    h.gitea.pullRequestUrl = null;
    const running = await runningPlan(h, singleTaskPlan());
    await completeTheTask(running);
    await tick(h.deps);

    expect((await manifestOf(running.planId))?.pr_url).toBeNull();
    expect(await planState(h, running.planId)).toBe('done');
  });
});

describe('when Gitea is unavailable at finalize', () => {
  it('holds the plan in finalizing and writes an error event', async () => {
    const running = await runningPlan(h, singleTaskPlan());
    await completeTheTask(running);

    h.gitea.throwAlways.add('openPullRequest');
    await tick(h.deps);

    expect(await planState(h, running.planId)).toBe('finalizing');
    const { rows } = await h.pool.query<{ payload: { stage: string } }>(
      "SELECT payload FROM events WHERE type = 'error' AND plan_id = $1",
      [running.planId],
    );
    expect(rows[0]?.payload.stage).toBe('finalize');
  });

  it('does not authorise teardown while the manifest is unwritten', async () => {
    const running = await runningPlan(h, singleTaskPlan());
    await completeTheTask(running);

    h.gitea.throwAlways.add('openPullRequest');
    await tick(h.deps);

    expect(h.supervisors.teardowns).toEqual([]);
    expect(await manifestOf(running.planId)).toBeNull();
  });

  it('retries and succeeds on the next tick', async () => {
    const running = await runningPlan(h, singleTaskPlan());
    await completeTheTask(running);

    h.gitea.throwOnce.add('openPullRequest');
    await tick(h.deps);
    expect(await planState(h, running.planId)).toBe('finalizing');

    await tick(h.deps);
    expect(await planState(h, running.planId)).toBe('done');
    expect(await manifestOf(running.planId)).not.toBeNull();
  });
});

describe('environment TTL', () => {
  it('fails the plan and cancels its tasks once the TTL passes', async () => {
    const running = await runningPlan(h, { ...singleTaskPlan(), env_ttl_min: 20 });
    const taskId = running.taskIds['only'] as string;

    h.clock.advanceMinutes(21);
    await heartbeat(h, running.supervisor.id);
    await tick(h.deps);

    expect(await planState(h, running.planId)).toBe('failed');
    expect(await taskState(h, taskId)).toBe('cancelled');

    const { rows } = await h.pool.query<{ terminal_reason: string }>(
      'SELECT terminal_reason FROM plans WHERE id = $1',
      [running.planId],
    );
    expect(rows[0]?.terminal_reason).toBe('ttl_expired');
  });

  it('authorises teardown naming the TTL', async () => {
    const running = await runningPlan(h, { ...singleTaskPlan(), env_ttl_min: 20 });
    h.clock.advanceMinutes(21);
    await heartbeat(h, running.supervisor.id);
    await tick(h.deps);

    expect(h.supervisors.teardowns[0]?.reason).toBe('ttl_expired');
  });

  it('leaves a plan inside its TTL alone', async () => {
    const running = await runningPlan(h, { ...singleTaskPlan(), env_ttl_min: 60 });
    h.clock.advanceMinutes(30);
    await heartbeat(h, running.supervisor.id);
    await tick(h.deps);

    expect(await planState(h, running.planId)).toBe('running');
  });
});

describe('a lost supervisor', () => {
  it('fails the plan rather than holding it until the TTL', async () => {
    const running = await runningPlan(h, { ...singleTaskPlan(), env_ttl_min: 240 });

    h.clock.advanceMinutes(6);
    await tick(h.deps);

    expect(await planState(h, running.planId)).toBe('failed');
    const { rows } = await h.pool.query<{ terminal_reason: string }>(
      'SELECT terminal_reason FROM plans WHERE id = $1',
      [running.planId],
    );
    expect(rows[0]?.terminal_reason).toBe('supervisor_lost');
  });

  it('still authorises teardown, so a returning VM finds no orphan', async () => {
    const running = await runningPlan(h, singleTaskPlan());
    h.clock.advanceMinutes(6);
    await tick(h.deps);

    expect(h.supervisors.teardowns[0]).toMatchObject({
      planId: running.planId,
      reason: 'failed',
    });
  });

  it('leaves a plan alone while its supervisor keeps heartbeating', async () => {
    const running = await runningPlan(h, singleTaskPlan());

    for (let i = 0; i < 4; i += 1) {
      h.clock.advanceMinutes(2);
      await heartbeat(h, running.supervisor.id);
      await tick(h.deps);
    }

    expect(await planState(h, running.planId)).toBe('running');
  });
});

describe('finalize is idempotent', () => {
  it('does nothing to a plan that already finished', async () => {
    const running = await runningPlan(h, singleTaskPlan());
    await completeTheTask(running);
    await tick(h.deps);

    const before = await manifestOf(running.planId);
    h.gitea.openPullRequestCalls.length = 0;
    h.supervisors.teardowns.length = 0;

    await tick(h.deps);
    await tick(h.deps);

    expect(await manifestOf(running.planId)).toEqual(before);
    expect(h.gitea.openPullRequestCalls).toEqual([]);
    expect(h.supervisors.teardowns).toEqual([]);
  });
});

describe('the operator can read the outcome', () => {
  it('serves the plan with its tasks and manifest', async () => {
    const running = await runningPlan(h, singleTaskPlan());
    await completeTheTask(running, 99);
    await tick(h.deps);

    const response = await h.app.inject({
      method: 'GET',
      url: `/plans/${running.planId}`,
      headers: operatorHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.plan.state).toBe('done');
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0].tokens_spent).toBe(99);
    expect(body.manifest.pr_url).toBe('http://gitea.local/mycelium/demo/pulls/1');
  });
});
