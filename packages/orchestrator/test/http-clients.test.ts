import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from 'undici';
import { HttpGiteaClient } from '../src/clients/gitea.js';
import { HttpSupervisorClient } from '../src/clients/supervisor.js';

const SUPERVISOR = { id: 'agent-1', name: 'worker-1', base_url: 'http://worker.test:8080' };
const GITEA_ORIGIN = 'http://gitea.test';

let agent: MockAgent;
let original: Dispatcher;

beforeEach(() => {
  original = getGlobalDispatcher();
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
});

afterEach(async () => {
  setGlobalDispatcher(original);
  await agent.close();
});

function planDispatch() {
  return {
    plan_id: 'plan-1',
    project: { id: 'proj-1', name: 'demo' },
    gitea: { repo_url: 'http://gitea.test/mycelium/demo.git', branch: 'plan/plan-1', bot_token: 'b' },
    orchestrator_token: 't',
    egress: ['example.com'],
    env_ttl_min: 240,
  };
}

describe('HttpSupervisorClient.dispatchPlan', () => {
  it('accepts a 2xx', async () => {
    agent
      .get(SUPERVISOR.base_url)
      .intercept({ path: '/plans', method: 'POST' })
      .reply(200, { accepted: true });

    const result = await new HttpSupervisorClient().dispatchPlan(SUPERVISOR, planDispatch());
    expect(result).toEqual({ accepted: true });
  });

  it('reads a structured capacity rejection as retryable', async () => {
    agent
      .get(SUPERVISOR.base_url)
      .intercept({ path: '/plans', method: 'POST' })
      .reply(503, { code: 'capacity_exceeded' });

    const result = await new HttpSupervisorClient().dispatchPlan(SUPERVISOR, planDispatch());
    expect(result).toEqual({ accepted: false, code: 'capacity_exceeded', retryable: true });
  });

  it('reads a validation rejection as terminal', async () => {
    agent
      .get(SUPERVISOR.base_url)
      .intercept({ path: '/plans', method: 'POST' })
      .reply(400, { code: 'validation_failed' });

    const result = await new HttpSupervisorClient().dispatchPlan(SUPERVISOR, planDispatch());
    expect(result).toEqual({ accepted: false, code: 'validation_failed', retryable: false });
  });

  it('treats an unexplained error as a capacity rejection', async () => {
    agent
      .get(SUPERVISOR.base_url)
      .intercept({ path: '/plans', method: 'POST' })
      .reply(500, 'upstream is unwell');

    const result = await new HttpSupervisorClient().dispatchPlan(SUPERVISOR, planDispatch());
    expect(result.accepted).toBe(false);
    expect(result).toMatchObject({ code: 'capacity_exceeded', retryable: true });
  });

  it('treats an unreachable VM exactly like a full one, so failover proceeds', async () => {
    agent
      .get(SUPERVISOR.base_url)
      .intercept({ path: '/plans', method: 'POST' })
      .replyWithError(new Error('ECONNREFUSED'));

    const result = await new HttpSupervisorClient().dispatchPlan(SUPERVISOR, planDispatch());
    expect(result).toEqual({ accepted: false, code: 'capacity_exceeded', retryable: true });
  });

  it('sends the dispatch as JSON', async () => {
    let seen = '';
    agent
      .get(SUPERVISOR.base_url)
      .intercept({ path: '/plans', method: 'POST' })
      .reply(200, (options) => {
        seen = String(options.body);
        return { accepted: true };
      });

    await new HttpSupervisorClient().dispatchPlan(SUPERVISOR, planDispatch());
    expect(JSON.parse(seen).plan_id).toBe('plan-1');
  });
});

describe('HttpSupervisorClient task and teardown', () => {
  const task = {
    plan_id: 'plan-1',
    task_id: 'task-1',
    local_id: 'only',
    dispatch_id: 'd-1',
    execution_attempt: 0,
    description: 'do it',
    limits: { cost_microusd: 10, wall_clock_min: 5 },
    cost_spent_so_far_microusd: 0,
  };

  it('posts a task to the plan task route', async () => {
    agent
      .get(SUPERVISOR.base_url)
      .intercept({ path: '/plans/plan-1/tasks', method: 'POST' })
      .reply(200, {});

    expect(await new HttpSupervisorClient().dispatchTask(SUPERVISOR, task)).toEqual({
      accepted: true,
    });
  });

  it('reports a rejected task as not accepted', async () => {
    agent
      .get(SUPERVISOR.base_url)
      .intercept({ path: '/plans/plan-1/tasks', method: 'POST' })
      .reply(409, {});

    expect(await new HttpSupervisorClient().dispatchTask(SUPERVISOR, task)).toEqual({
      accepted: false,
    });
  });

  it('posts the teardown reason', async () => {
    let seen = '';
    agent
      .get(SUPERVISOR.base_url)
      .intercept({ path: '/plans/plan-1/teardown', method: 'POST' })
      .reply(200, (options) => {
        seen = String(options.body);
        return {};
      });

    await new HttpSupervisorClient().authorizeTeardown(SUPERVISOR, 'plan-1', 'ttl_expired');
    expect(JSON.parse(seen)).toEqual({ reason: 'ttl_expired' });
  });
});

describe('HttpGiteaClient', () => {
  function client() {
    return new HttpGiteaClient({
      baseUrl: GITEA_ORIGIN,
      owner: 'mycelium',
      adminToken: 'admin-token',
    });
  }

  it('reuses an existing repo instead of creating one', async () => {
    agent
      .get(GITEA_ORIGIN)
      .intercept({ path: '/api/v1/repos/mycelium/demo', method: 'GET' })
      .reply(200, { clone_url: 'http://gitea.test/mycelium/demo.git' });

    const result = await client().ensureRepo('demo');
    expect(result.clone_url).toBe('http://gitea.test/mycelium/demo.git');
  });

  // The create path must name the same owner the lookup reads back, or a repo is
  // created once under whoever holds the admin token and never found again.
  it('creates a repo under the configured owner when it is absent', async () => {
    let body = '';
    agent
      .get(GITEA_ORIGIN)
      .intercept({ path: '/api/v1/repos/mycelium/demo', method: 'GET' })
      .reply(404, { message: 'not found' });
    agent
      .get(GITEA_ORIGIN)
      .intercept({ path: '/api/v1/orgs/mycelium/repos', method: 'POST' })
      .reply(201, (options) => {
        body = String(options.body);
        return { clone_url: 'http://gitea.test/mycelium/demo.git' };
      });

    await client().ensureRepo('demo');
    // Without auto_init there is no branch point for plan/<id>.
    expect(JSON.parse(body)).toMatchObject({ name: 'demo', auto_init: true, private: true });
  });

  it('creates under the owner it was configured with, not a fixed one', async () => {
    const configured = new HttpGiteaClient({
      baseUrl: GITEA_ORIGIN,
      owner: 'other-org',
      adminToken: 'admin-token',
    });
    agent
      .get(GITEA_ORIGIN)
      .intercept({ path: '/api/v1/repos/other-org/demo', method: 'GET' })
      .reply(404, { message: 'not found' });
    agent
      .get(GITEA_ORIGIN)
      .intercept({ path: '/api/v1/orgs/other-org/repos', method: 'POST' })
      .reply(201, { clone_url: 'http://gitea.test/other-org/demo.git' });

    const result = await configured.ensureRepo('demo');
    expect(result.clone_url).toBe('http://gitea.test/other-org/demo.git');
  });

  it('sends the admin token', async () => {
    let auth: string | undefined;
    agent
      .get(GITEA_ORIGIN)
      .intercept({ path: '/api/v1/repos/mycelium/demo', method: 'GET' })
      .reply(200, (options) => {
        auth = (options.headers as Record<string, string>).authorization;
        return { clone_url: 'x' };
      });

    await client().ensureRepo('demo');
    expect(auth).toBe('token admin-token');
  });

  it('treats an existing branch as success', async () => {
    agent
      .get(GITEA_ORIGIN)
      .intercept({ path: '/api/v1/repos/mycelium/demo/branches', method: 'POST' })
      .reply(409, { message: 'branch already exists' });

    await expect(client().createBranch('demo', 'plan/1', 'main')).resolves.toBeUndefined();
  });

  it('raises on an unexpected branch failure', async () => {
    agent
      .get(GITEA_ORIGIN)
      .intercept({ path: '/api/v1/repos/mycelium/demo/branches', method: 'POST' })
      .reply(500, {});

    await expect(client().createBranch('demo', 'plan/1', 'main')).rejects.toThrow(/500/);
  });

  it('reports a file that exists', async () => {
    agent
      .get(GITEA_ORIGIN)
      .intercept({ path: '/api/v1/repos/mycelium/demo/contents/docs/report.md?ref=plan%2F1' })
      .reply(200, { name: 'report.md' });

    expect(await client().fileExists('demo', 'plan/1', 'docs/report.md')).toBe(true);
  });

  it('reports a file that does not', async () => {
    agent
      .get(GITEA_ORIGIN)
      .intercept({ path: '/api/v1/repos/mycelium/demo/contents/missing.md?ref=plan%2F1' })
      .reply(404, {});

    expect(await client().fileExists('demo', 'plan/1', 'missing.md')).toBe(false);
  });

  it('reads the head sha of a branch', async () => {
    agent
      .get(GITEA_ORIGIN)
      .intercept({ path: '/api/v1/repos/mycelium/demo/branches/plan%2F1' })
      .reply(200, { commit: { id: 'deadbeef' } });

    expect(await client().headSha('demo', 'plan/1')).toBe('deadbeef');
  });

  it('returns null when the plan branch has no commits ahead of main', async () => {
    agent
      .get(GITEA_ORIGIN)
      .intercept({ path: '/api/v1/repos/mycelium/demo/branches/plan%2F1' })
      .reply(200, { commit: { id: 'same' } });
    agent
      .get(GITEA_ORIGIN)
      .intercept({ path: '/api/v1/repos/mycelium/demo/branches/main' })
      .reply(200, { commit: { id: 'same' } });

    expect(await client().openPullRequest('demo', 'plan/1', 'main', 'Plan 1')).toBeNull();
  });

  it('reuses an open pull request rather than opening a second', async () => {
    agent
      .get(GITEA_ORIGIN)
      .intercept({ path: '/api/v1/repos/mycelium/demo/branches/plan%2F1' })
      .reply(200, { commit: { id: 'ahead' } });
    agent
      .get(GITEA_ORIGIN)
      .intercept({ path: '/api/v1/repos/mycelium/demo/branches/main' })
      .reply(200, { commit: { id: 'behind' } });
    agent
      .get(GITEA_ORIGIN)
      .intercept({ path: '/api/v1/repos/mycelium/demo/pulls?state=open&limit=50' })
      .reply(200, [
        { head: { ref: 'plan/1' }, base: { ref: 'main' }, html_url: 'http://gitea.test/pr/7' },
      ]);

    const result = await client().openPullRequest('demo', 'plan/1', 'main', 'Plan 1');
    expect(result).toEqual({ url: 'http://gitea.test/pr/7' });
  });

  it('opens a pull request when none exists', async () => {
    agent
      .get(GITEA_ORIGIN)
      .intercept({ path: '/api/v1/repos/mycelium/demo/branches/plan%2F1' })
      .reply(200, { commit: { id: 'ahead' } });
    agent
      .get(GITEA_ORIGIN)
      .intercept({ path: '/api/v1/repos/mycelium/demo/branches/main' })
      .reply(200, { commit: { id: 'behind' } });
    agent
      .get(GITEA_ORIGIN)
      .intercept({ path: '/api/v1/repos/mycelium/demo/pulls?state=open&limit=50' })
      .reply(200, []);
    agent
      .get(GITEA_ORIGIN)
      .intercept({ path: '/api/v1/repos/mycelium/demo/pulls', method: 'POST' })
      .reply(201, { html_url: 'http://gitea.test/pr/8' });

    const result = await client().openPullRequest('demo', 'plan/1', 'main', 'Plan 1');
    expect(result).toEqual({ url: 'http://gitea.test/pr/8' });
  });

  it('treats an already-deleted bot user as revoked', async () => {
    agent
      .get(GITEA_ORIGIN)
      .intercept({ path: '/api/v1/admin/users/bot-1', method: 'DELETE' })
      .reply(404, {});

    await expect(client().revokeBotToken('bot-1')).resolves.toBeUndefined();
  });

  it('mints the bot token as the bot user over basic auth, not with the admin token', async () => {
    let tokenAuth: string | undefined;
    let adminUsersAuth: string | undefined;
    agent
      .get(GITEA_ORIGIN)
      .intercept({ path: '/api/v1/admin/users/mycelium-bot-plan1', method: 'DELETE' })
      .reply(404, {});
    agent
      .get(GITEA_ORIGIN)
      .intercept({ path: '/api/v1/admin/users', method: 'POST' })
      .reply(201, (options) => {
        adminUsersAuth = (options.headers as Record<string, string>).authorization;
        return {};
      });
    agent
      .get(GITEA_ORIGIN)
      .intercept({
        path: '/api/v1/repos/mycelium/demo/collaborators/mycelium-bot-plan1',
        method: 'PUT',
      })
      .reply(204, {});
    agent
      .get(GITEA_ORIGIN)
      .intercept({ path: '/api/v1/users/mycelium-bot-plan1/tokens', method: 'POST' })
      .reply(201, (options) => {
        tokenAuth = (options.headers as Record<string, string>).authorization;
        return { sha1: 'bot-token-sha' };
      });

    const result = await client().createBotToken('demo', 'plan1');

    expect(result).toEqual({ token: 'bot-token-sha', ref: 'mycelium-bot-plan1' });
    // The user is still created with the admin token, as before.
    expect(adminUsersAuth).toBe('token admin-token');
    // The token itself Gitea will only mint for the user authenticating as itself.
    expect(tokenAuth).toMatch(/^Basic /);
    const [user, pass] = Buffer.from(tokenAuth!.slice('Basic '.length), 'base64')
      .toString('utf8')
      .split(':');
    expect(user).toBe('mycelium-bot-plan1');
    expect((pass ?? '').length).toBeGreaterThan(0);
  });

  it('clears a bot user left by a failed earlier attempt before recreating it', async () => {
    let deleted = false;
    agent
      .get(GITEA_ORIGIN)
      .intercept({ path: '/api/v1/admin/users/mycelium-bot-plan1', method: 'DELETE' })
      .reply(204, () => {
        deleted = true;
        return {};
      });
    agent
      .get(GITEA_ORIGIN)
      .intercept({ path: '/api/v1/admin/users', method: 'POST' })
      .reply(201, {});
    agent
      .get(GITEA_ORIGIN)
      .intercept({
        path: '/api/v1/repos/mycelium/demo/collaborators/mycelium-bot-plan1',
        method: 'PUT',
      })
      .reply(204, {});
    agent
      .get(GITEA_ORIGIN)
      .intercept({ path: '/api/v1/users/mycelium-bot-plan1/tokens', method: 'POST' })
      .reply(201, { sha1: 'x' });

    await client().createBotToken('demo', 'plan1');
    expect(deleted).toBe(true);
  });

  it('raises if clearing a stale bot user fails for a reason other than absence', async () => {
    agent
      .get(GITEA_ORIGIN)
      .intercept({ path: '/api/v1/admin/users/mycelium-bot-plan1', method: 'DELETE' })
      .reply(500, {});

    await expect(client().createBotToken('demo', 'plan1')).rejects.toThrow(/500/);
  });
});
