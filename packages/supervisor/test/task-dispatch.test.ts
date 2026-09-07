import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestHarness } from './helpers/app.js';
import type { FakeAgentHandle } from './helpers/fakes.js';

let h: TestHarness;
let agent: FakeAgentHandle;

const PLAN_ID = '018f3a5c-0000-7000-8000-00000000000a';

function taskDispatch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    plan_id: PLAN_ID,
    task_id: '018f3a5c-0000-7000-8000-0000000000c1',
    local_id: 'scrape',
    dispatch_id: '018f3a5c-0000-7000-8000-0000000000d1',
    execution_attempt: 0,
    description: 'Scrape the index page and commit the result',
    limits: { cost_microusd: 50_000, wall_clock_min: 30 },
    cost_spent_so_far_microusd: 0,
    ...overrides,
  };
}

beforeAll(async () => {
  h = await buildTestApp();
});

afterAll(async () => {
  await h.close();
});

beforeEach(() => {
  h.reset();
  agent = h.provisionEnvironment(PLAN_ID);
});

function send(payload: Record<string, unknown> = taskDispatch(), planId = PLAN_ID) {
  return h.inject({ method: 'POST', url: `/plans/${planId}/tasks`, payload });
}

describe('POST /plans/:id/tasks', () => {
  it('hands the dispatch to that plan\'s agent and accepts', async () => {
    const response = await send();

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: true });
    expect(agent.dispatches).toHaveLength(1);
  });

  // The supervisor is a proxy, not a scheduler: it forwards the envelope whole
  // and reads nothing out of it.
  it('forwards the dispatch unchanged, including the dispatch id', async () => {
    const task = taskDispatch();
    await send(task);

    expect(agent.dispatches[0]).toEqual(task);
  });

  it('does not queue for a plan this node is not running', async () => {
    const response = await send(taskDispatch(), '018f3a5c-0000-7000-8000-0000000000ff');

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('no_environment');
  });

  // The orchestrator returns the task to ready at once rather than waiting out
  // a 60-second lease, so refusing loudly is cheaper than accepting quietly.
  it('refuses when the agent is not accepting', async () => {
    agent.accepting = false;
    const response = await send();

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('agent_not_accepting');
  });

  it('refuses when the agent has already exited', async () => {
    await agent.signal('SIGKILL');
    const response = await send();

    expect(response.statusCode).toBe(409);
  });

  it('reports a broken agent socket rather than hanging', async () => {
    agent.dispatch = async () => {
      throw new Error('ECONNREFUSED on the dispatch socket');
    };
    const response = await send();

    expect(response.statusCode).toBe(409);
  });

  it('never retries: the lease is what covers a lost dispatch', async () => {
    agent.accepting = false;
    await send();

    expect(agent.dispatches).toHaveLength(1);
  });
});
