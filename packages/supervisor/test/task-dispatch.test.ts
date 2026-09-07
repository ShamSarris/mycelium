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

  /**
   * The agent answers a malformed dispatch with an RPC error naming the
   * reason (`invalid_params`, `wrong_plan`), and that reason is the entire
   * diagnosis of a plan that will otherwise redispatch on a two-second loop
   * until its TTL. It used to be discarded: `call()` collapsed every
   * non-`ok` envelope to null and the route logged nothing on this path, so
   * the operator saw forty identical `supervisor_rejected` events and no
   * cause anywhere. It has to reach both the log and the 409 body.
   */
  it('reports the reason the agent gave, rather than a bare refusal', async () => {
    agent.refuseWith = { code: 'invalid_params', message: 'that is not a task dispatch' };
    const response = await send();

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('agent_not_accepting');
    expect(response.json().message).toContain('invalid_params');
    expect(response.json().message).toContain('that is not a task dispatch');
  });

  it('distinguishes an agent that refused from one it could not reach', async () => {
    agent.refuseWith = { code: 'wrong_plan', message: 'this agent is not running that plan' };
    const refused = await send();
    expect(refused.json().message).toContain('wrong_plan');

    agent.unreachable = true;
    const unreachable = await send();
    expect(unreachable.json().message).not.toContain('wrong_plan');
    expect(unreachable.json().message).toMatch(/could not be reached|unreachable/i);
  });

  /**
   * A refusal is the agent answering. Treating it as death is what turned one
   * real diagnosis into a run of misleading "the plan agent has exited"
   * replies on every later attempt — only `AdoptedAgent` did this, so it
   * needed a supervisor restart to show, but the agent was alive throughout.
   */
  it('does not mark a live agent as exited because it refused a task', async () => {
    agent.refuseWith = { code: 'invalid_params', message: 'that is not a task dispatch' };
    await send();

    expect(agent.hasExited()).toBe(false);

    const second = await send();
    expect(second.json().message).toContain('invalid_params');
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
