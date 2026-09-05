import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from 'undici';
import { HttpOrchestratorClient, StatusRejected } from '../src/orchestrator.js';
import { reportStatus } from '../src/reporting.js';
import { buildTestWorker, PLAN_ID, type TestWorker } from './helpers/agent.js';
import { statusRejected } from './helpers/fakes.js';

/**
 * The agent's only write path into task state (baseline section 5 step 6), and
 * the one call it makes that does not go through the supervisor. That is what
 * lets a supervisor restart re-attach without recovering any in-flight task
 * state: the agent never noticed it was gone.
 */

const TASK_ID = '018f3a5c-0000-7000-8000-0000000000c1';
const ORIGIN = 'http://orchestrator.tailnet:8080';

let h: TestWorker;

beforeEach(async () => {
  h = await buildTestWorker();
});

afterEach(async () => {
  await h.close();
});

describe('HttpOrchestratorClient', () => {
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

  function client(): HttpOrchestratorClient {
    return new HttpOrchestratorClient(ORIGIN, PLAN_ID, 'plan-token', 10_000);
  }

  it('posts to the plan-scoped task route with the per-plan token', async () => {
    let seen: { path: string; auth: unknown; body: unknown } | null = null;

    agent
      .get(ORIGIN)
      .intercept({ path: `/plans/${PLAN_ID}/tasks/${TASK_ID}/status`, method: 'POST' })
      .reply(200, (options) => {
        seen = {
          path: String(options.path),
          auth: (options.headers as Record<string, string>).authorization,
          body: JSON.parse(String(options.body)),
        };
        return { task_id: TASK_ID, state: 'running' };
      });

    await client().reportStatus(TASK_ID, { state: 'running' });

    expect(seen).not.toBeNull();
    expect(seen!.auth).toBe('Bearer plan-token');
    expect(seen!.body).toEqual({ state: 'running' });
  });

  it('sends the whole report when the task finishes', async () => {
    let body: unknown = null;
    agent
      .get(ORIGIN)
      .intercept({ path: `/plans/${PLAN_ID}/tasks/${TASK_ID}/status`, method: 'POST' })
      .reply(200, (options) => {
        body = JSON.parse(String(options.body));
        return {};
      });

    await client().reportStatus(TASK_ID, {
      state: 'done',
      tokens_spent: 4200,
      result: { summary: 'added the endpoint', commit_sha: 'abc' },
    });

    expect(body).toEqual({
      state: 'done',
      tokens_spent: 4200,
      result: { summary: 'added the endpoint', commit_sha: 'abc' },
    });
  });

  it('turns a 4xx into StatusRejected, which is not worth retrying', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: `/plans/${PLAN_ID}/tasks/${TASK_ID}/status`, method: 'POST' })
      .reply(400, { error: { code: 'invalid_report', message: 'state must be one of' } });

    await expect(client().reportStatus(TASK_ID, { state: 'done' })).rejects.toBeInstanceOf(
      StatusRejected,
    );
  });

  it('throws something retryable on a 5xx', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: `/plans/${PLAN_ID}/tasks/${TASK_ID}/status`, method: 'POST' })
      .reply(503, 'unavailable');

    const error = await client()
      .reportStatus(TASK_ID, { state: 'done' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(StatusRejected);
  });
});

describe('reportStatus', () => {
  it('reports once when the orchestrator answers', async () => {
    await reportStatus(h.deps, TASK_ID, { state: 'running' });

    expect(h.orchestrator.reports).toHaveLength(1);
    expect(h.orchestrator.last).toEqual({ state: 'running' });
    expect(h.broker.ofType('error')).toHaveLength(0);
  });

  it('retries a transient failure and succeeds', async () => {
    h.orchestrator.failFirst = 2;

    await reportStatus(h.deps, TASK_ID, { state: 'done', tokens_spent: 10 });

    expect(h.orchestrator.reports).toHaveLength(1);
    expect(h.sleeps).toHaveLength(2);
    expect(h.broker.ofType('error')).toHaveLength(0);
  });

  it('gives up after the configured number of retries and says so as an event', async () => {
    h.orchestrator.failFirst = Number.MAX_SAFE_INTEGER;

    await reportStatus(h.deps, TASK_ID, { state: 'done' });

    // Three retries after the first attempt, then abandoned. The
    // orchestrator's lease expiry is the backstop, which is what it is for.
    expect(h.sleeps).toHaveLength(h.config.statusRetryLimit);
    const errors = h.broker.ofType('error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.severity).toBe('error');
    expect(errors[0]?.taskId).toBe(TASK_ID);
    expect(errors[0]?.payload).toMatchObject({ stage: 'status_report', state: 'done' });
  });

  it('backs off between attempts rather than hammering', async () => {
    h.orchestrator.failFirst = Number.MAX_SAFE_INTEGER;

    await reportStatus(h.deps, TASK_ID, { state: 'failed', error: 'boom' });

    const increasing = h.sleeps.every((ms, i) => i === 0 || ms > (h.sleeps[i - 1] as number));
    expect(increasing).toBe(true);
    // The whole thing stays inside the configured window.
    expect(h.sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(
      h.config.statusRetryWindowMs,
    );
  });

  it('does not retry a report the orchestrator refused', async () => {
    h.orchestrator.failWith = statusRejected(400);

    await reportStatus(h.deps, TASK_ID, { state: 'done' });

    // Retrying a 4xx only re-sends the same wrong body. Report it and move on.
    expect(h.sleeps).toHaveLength(0);
    expect(h.broker.ofType('error')).toHaveLength(1);
  });

  it('never throws, whatever happened', async () => {
    h.orchestrator.failWith = new Error('the network is gone');

    await expect(reportStatus(h.deps, TASK_ID, { state: 'done' })).resolves.toBeUndefined();
  });

  it('takes a shorter deadline and no retries when shutdown asks for one', async () => {
    h.orchestrator.failFirst = Number.MAX_SAFE_INTEGER;

    await reportStatus(h.deps, TASK_ID, { state: 'failed', error: 'aborted: ttl_expired' }, {
      retries: 0,
      timeoutMs: h.config.shutdownStatusTimeoutMs,
    });

    // B15 gives the whole shutdown five seconds. There is no room to retry.
    expect(h.sleeps).toHaveLength(0);
  });
});
