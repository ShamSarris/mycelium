import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tick } from '../src/services/dispatcher.js';
import { buildTestApp, bearer, type TestHarness } from './helpers/app.js';
import {
  eventTypes,
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

function report(
  running: RunningPlan,
  taskId: string,
  payload: Record<string, unknown>,
  token = running.planToken,
) {
  return h.app.inject({
    method: 'POST',
    url: `/plans/${running.planId}/tasks/${taskId}/status`,
    headers: bearer(token),
    payload,
  });
}

async function taskRow(taskId: string) {
  const { rows } = await h.pool.query<{
    state: string;
    dispatch_id: string | null;
    dispatch_attempt: number;
    execution_attempt: number;
    lease_expires_at: Date | null;
    started_at: Date | null;
    tokens_spent: number;
    cost_spent_microusd: number;
    error: string | null;
  }>(
    `SELECT state::text AS state, dispatch_id, dispatch_attempt, execution_attempt,
            lease_expires_at, started_at, tokens_spent, cost_spent_microusd, error
       FROM tasks WHERE id = $1`,
    [taskId],
  );
  return rows[0];
}

describe('claiming and dispatching', () => {
  it('dispatches a ready task under a lease', async () => {
    const running = await runningPlan(h, singleTaskPlan());
    const taskId = running.taskIds['only'] as string;

    const row = await taskRow(taskId);
    expect(row?.state).toBe('dispatched');
    expect(row?.dispatch_attempt).toBe(1);
    expect(row?.lease_expires_at?.toISOString()).toBe(
      new Date(h.clock.now().getTime() + 60_000).toISOString(),
    );
  });

  it('sends the task dispatch with its dispatch id and limits', async () => {
    const running = await runningPlan(h, singleTaskPlan());
    const taskId = running.taskIds['only'] as string;
    const row = await taskRow(taskId);

    const request = h.supervisors.taskDispatches[0]?.request;
    expect(request?.task_id).toBe(taskId);
    expect(request?.local_id).toBe('only');
    expect(request?.dispatch_id).toBe(row?.dispatch_id);
    expect(request?.execution_attempt).toBe(0);
    expect(request?.description).toBe('Do the one thing.');
    expect(request?.limits).toEqual({ cost_microusd: 1000, wall_clock_min: 10 });
    expect(request?.cost_spent_so_far_microusd).toBe(0);
  });

  /**
   * The wire this payload crosses is hand-validated on the far side by
   * `parseDispatch` in `packages/worker/src/dispatch.ts`, which rejects the
   * whole dispatch — `invalid_params`, not a soft refusal — if any field is
   * missing or of the wrong runtime type. The supervisor forwards the
   * envelope verbatim and never inspects it, so nothing between here and
   * there can correct a mismatch, and the orchestrator's own types cannot
   * catch one: the two `TaskDispatch` interfaces are hand-kept copies in
   * separate packages that do not depend on each other.
   *
   * This asserts the exact key set and the exact runtime types that
   * `parseDispatch` demands. It is the only thing in this repo that holds the
   * two halves of that wire together.
   */
  it('matches every field the worker-s parseDispatch requires, by name and runtime type', async () => {
    const running = await runningPlan(h, singleTaskPlan());
    const request = h.supervisors.taskDispatches[0]?.request as unknown as Record<string, unknown>;
    expect(request).toBeDefined();

    for (const field of [
      'plan_id',
      'task_id',
      'local_id',
      'dispatch_id',
      'description',
    ]) {
      expect(typeof request[field], field).toBe('string');
    }

    for (const field of ['execution_attempt', 'cost_spent_so_far_microusd']) {
      expect(typeof request[field], field).toBe('number');
    }

    const limits = request.limits as Record<string, unknown>;
    expect(typeof limits.cost_microusd).toBe('number');
    expect(typeof limits.wall_clock_min).toBe('number');

    expect(running.planId).toBe(request.plan_id);
  });

  it('sends the prior cost spend as a number, not the string pg returns for a bigint', async () => {
    const running = await runningPlan(h, singleTaskPlan());
    const taskId = running.taskIds['only'] as string;

    // `tasks.cost_spent_microusd` is bigint, and `pg` hands bigints back as
    // strings even for a single unaggregated row. `claimNextTask` selects it
    // through `TASK_COLUMNS` and types the result as `TaskRow`, whose field
    // is declared `number` — so without an explicit parse the type is a lie
    // and the worker rejects the dispatch on `typeof !== 'number'`.
    await h.deps.pool.query('UPDATE tasks SET cost_spent_microusd = $2 WHERE id = $1', [
      taskId,
      4321,
    ]);
    await h.deps.pool.query(
      "UPDATE tasks SET state = 'ready', dispatch_id = NULL WHERE id = $1",
      [taskId],
    );
    h.supervisors.taskDispatches.length = 0;
    await tick(h.deps);

    const request = h.supervisors.taskDispatches[0]?.request;
    expect(request?.cost_spent_so_far_microusd).toBe(4321);
    expect(typeof request?.cost_spent_so_far_microusd).toBe('number');
  });

  it('writes a task.dispatched event', async () => {
    const running = await runningPlan(h, singleTaskPlan());
    expect(await eventTypes(h, running.planId)).toContain('task.dispatched');
  });

  // `max_concurrent_agents` was removed from the plan schema by the D30 cost
  // migration (ticket agent-sdk-migration/03,04) with no replacement landed
  // yet — concurrency control awaits ticket agent-sdk-migration/13
  // (supervisor-derived concurrency). There is currently no way to configure
  // a plan's dispatch concurrency to anything other than the hardcoded
  // default of 2; see ticket 05's completion report for the gap. Skipped
  // rather than deleted so the coverage this used to provide is not lost to
  // silence.
  it.skip('honours max_concurrent_agents', async () => {
    const plan = {
      ...validPlan(),
      max_concurrent_agents: 1,
      tasks: [
        { id: 'a', description: 'one', limits: { cost_microusd: 10, wall_clock_min: 5 } },
        { id: 'b', description: 'two', limits: { cost_microusd: 10, wall_clock_min: 5 } },
        { id: 'c', description: 'three', limits: { cost_microusd: 10, wall_clock_min: 5 } },
      ],
    };
    await runningPlan(h, plan);
    await tick(h.deps);

    expect(h.supervisors.taskDispatches).toHaveLength(1);
  });

  it('dispatches up to the (currently hardcoded) default of 2 and no further', async () => {
    // `max_concurrent_agents` is no longer a settable plan field (see the
    // skipped test above); this now exercises the built-in default rather
    // than an operator-chosen limit.
    const plan = {
      ...validPlan(),
      tasks: [
        { id: 'a', description: 'one', limits: { cost_microusd: 10, wall_clock_min: 5 } },
        { id: 'b', description: 'two', limits: { cost_microusd: 10, wall_clock_min: 5 } },
        { id: 'c', description: 'three', limits: { cost_microusd: 10, wall_clock_min: 5 } },
      ],
    };
    await runningPlan(h, plan);
    expect(h.supervisors.taskDispatches).toHaveLength(2);
  });

  it('returns the task to ready at once when the supervisor call throws', async () => {
    const supervisorPlan = singleTaskPlan();
    h.supervisors.taskThrows = true;
    const running = await runningPlan(h, supervisorPlan);
    const taskId = running.taskIds['only'] as string;

    const row = await taskRow(taskId);
    expect(row?.state).toBe('ready');
    expect(row?.lease_expires_at).toBeNull();
    expect(row?.dispatch_id).toBeNull();
  });

  it('returns the task to ready when the supervisor declines it', async () => {
    h.supervisors.taskAccepted = false;
    const running = await runningPlan(h, singleTaskPlan());
    expect(await taskState(h, running.taskIds['only'] as string)).toBe('ready');
  });

  /**
   * A rejected dispatch is redispatched every couple of seconds until the
   * plan's TTL, so this event is written hundreds of times. Without the
   * supervisor's own reason on it, all of those rows say `supervisor_rejected`
   * and the operator has no way to tell a malformed dispatch from a busy
   * agent from a plan the node is not running — which is exactly the hole a
   * real stalled plan fell into.
   */
  it('records the reason the supervisor gave for refusing', async () => {
    h.supervisors.taskAccepted = false;
    h.supervisors.taskRejectionReason = 'invalid_params: that is not a task dispatch';
    const running = await runningPlan(h, singleTaskPlan());

    const events = await h.deps.pool.query<{ payload: { reason?: string } }>(
      "SELECT payload FROM events WHERE plan_id = $1 AND type = 'task.state_changed'",
      [running.planId],
    );
    const reasons = events.rows.map((row) => row.payload.reason ?? '');
    expect(reasons.some((reason) => reason.includes('invalid_params'))).toBe(true);
  });
});

describe('acknowledgement and completion', () => {
  it('clears the lease when the agent reports running', async () => {
    const running = await runningPlan(h, singleTaskPlan());
    const taskId = running.taskIds['only'] as string;

    const response = await report(running, taskId, { state: 'running' });
    expect(response.statusCode).toBe(200);

    const row = await taskRow(taskId);
    expect(row?.state).toBe('running');
    expect(row?.lease_expires_at).toBeNull();
    expect(row?.started_at).not.toBeNull();
  });

  it('records both cost and tokens spent, and the result, on done', async () => {
    const running = await runningPlan(h, singleTaskPlan());
    const taskId = running.taskIds['only'] as string;

    await report(running, taskId, { state: 'running' });
    await report(running, taskId, {
      state: 'done',
      cost_spent_microusd: 9999,
      tokens_spent: 4321,
      result: { commit: 'abc' },
    });

    const row = await taskRow(taskId);
    expect(row?.state).toBe('done');
    // cost_spent_microusd is authoritative; tokens_spent is the detail figure
    // kept beside it. Both are reported and both are stored.
    expect(row?.cost_spent_microusd).toBe(9999);
    expect(row?.tokens_spent).toBe(4321);
  });

  it('promotes a dependant once its dependency is done', async () => {
    const running = await runningPlan(h);
    const first = running.taskIds['a-write-tests'] as string;
    const second = running.taskIds['b-implement'] as string;

    expect(await taskState(h, second)).toBe('pending');

    await report(running, first, { state: 'running' });
    await report(running, first, { state: 'done' });

    expect(await taskState(h, second)).toBe('ready');

    await tick(h.deps);
    expect(await taskState(h, second)).toBe('dispatched');
  });

  it('refuses a done report from a task that never acknowledged', async () => {
    const running = await runningPlan(h, singleTaskPlan());
    const response = await report(running, running.taskIds['only'] as string, { state: 'done' });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('illegal_transition');
  });
});

describe('lease expiry', () => {
  it('returns an unacknowledged task to ready and logs it', async () => {
    const running = await runningPlan(h, singleTaskPlan());
    const taskId = running.taskIds['only'] as string;

    h.clock.advance(61_000);
    await tick(h.deps);

    expect(await eventTypes(h, running.planId)).toContain('task.lease_expired');
    // The same tick re-dispatches it, which is the behaviour that matters.
    expect(h.supervisors.taskDispatches).toHaveLength(2);
    expect((await taskRow(taskId))?.dispatch_attempt).toBe(2);
  });

  it('does not expire a lease that is still live', async () => {
    const running = await runningPlan(h, singleTaskPlan());
    h.clock.advance(30_000);
    await tick(h.deps);

    expect(await eventTypes(h, running.planId)).not.toContain('task.lease_expired');
    expect(h.supervisors.taskDispatches).toHaveLength(1);
  });

  it('does not expire a task that acknowledged in time', async () => {
    const running = await runningPlan(h, singleTaskPlan());
    await report(running, running.taskIds['only'] as string, { state: 'running' });

    h.clock.advance(120_000);
    await heartbeat(h, running.supervisor.id);
    await tick(h.deps);

    expect(await eventTypes(h, running.planId)).not.toContain('task.lease_expired');
  });
});

describe('failure policy', () => {
  it('retries a task whose policy allows another attempt', async () => {
    const running = await runningPlan(
      h,
      singleTaskPlan({
        tasks: [
          {
            id: 'only',
            description: 'flaky',
            limits: { cost_microusd: 10, wall_clock_min: 5 },
            failure_policy: { type: 'retry', max_attempts: 2 },
          },
        ],
      }),
    );
    const taskId = running.taskIds['only'] as string;

    await report(running, taskId, { state: 'running' });
    await report(running, taskId, { state: 'failed', error: 'first attempt failed' });

    const row = await taskRow(taskId);
    expect(row?.state).toBe('ready');
    expect(row?.execution_attempt).toBe(1);
    expect(await planState(h, running.planId)).toBe('running');
  });

  it('fails the task once the attempts are exhausted', async () => {
    const running = await runningPlan(
      h,
      singleTaskPlan({
        tasks: [
          {
            id: 'only',
            description: 'flaky',
            limits: { cost_microusd: 10, wall_clock_min: 5 },
            failure_policy: { type: 'retry', max_attempts: 2 },
          },
        ],
      }),
    );
    const taskId = running.taskIds['only'] as string;

    await report(running, taskId, { state: 'running' });
    await report(running, taskId, { state: 'failed', error: 'one' });
    await tick(h.deps);
    await report(running, taskId, { state: 'running' });
    await report(running, taskId, { state: 'failed', error: 'two' });

    const row = await taskRow(taskId);
    expect(row?.state).toBe('failed');
    expect(row?.execution_attempt).toBe(2);
  });

  it('carries the prior cost spend into the retry dispatch', async () => {
    const running = await runningPlan(
      h,
      singleTaskPlan({
        tasks: [
          {
            id: 'only',
            description: 'flaky',
            limits: { cost_microusd: 100, wall_clock_min: 5 },
            failure_policy: { type: 'retry', max_attempts: 3 },
          },
        ],
      }),
    );
    const taskId = running.taskIds['only'] as string;

    await report(running, taskId, { state: 'running' });
    await report(running, taskId, {
      state: 'failed',
      error: 'one',
      cost_spent_microusd: 40,
      tokens_spent: 900,
    });
    await tick(h.deps);

    const second = h.supervisors.taskDispatches[1]?.request;
    expect(second?.execution_attempt).toBe(1);
    // Cost, because `limits.cost_microusd` is the ceiling this is deducted
    // from and it is task-wide across attempts (D30). The token figure the
    // same report carried is detail and deliberately does not travel.
    expect(second?.cost_spent_so_far_microusd).toBe(40);
  });

  it('halts the plan and cancels the siblings when the policy is halt', async () => {
    const plan = {
      ...validPlan(),
      tasks: [
        { id: 'a', description: 'one', limits: { cost_microusd: 10, wall_clock_min: 5 } },
        { id: 'b', description: 'two', limits: { cost_microusd: 10, wall_clock_min: 5 } },
        { id: 'c', description: 'three', limits: { cost_microusd: 10, wall_clock_min: 5 } },
      ],
    };
    const running = await runningPlan(h, plan);
    const a = running.taskIds['a'] as string;

    await report(running, a, { state: 'running' });
    await report(running, a, { state: 'failed', error: 'unrecoverable' });

    expect(await taskState(h, a)).toBe('failed');
    expect(await taskState(h, running.taskIds['b'] as string)).toBe('cancelled');
    expect(await taskState(h, running.taskIds['c'] as string)).toBe('cancelled');
    expect(await planState(h, running.planId)).toBe('finalizing');
  });
});

describe('the wall-clock sweep', () => {
  it('fails a running task that passes its cap plus the grace period', async () => {
    const running = await runningPlan(h, singleTaskPlan());
    const taskId = running.taskIds['only'] as string;

    await report(running, taskId, { state: 'running' });
    // 10 minute cap plus the 2 minute grace.
    h.clock.advanceMinutes(13);
    await heartbeat(h, running.supervisor.id);
    await tick(h.deps);

    const row = await taskRow(taskId);
    expect(row?.state).toBe('failed');
    expect(row?.error).toBe('wall_clock_exceeded');
    expect(await eventTypes(h, running.planId)).toContain('limit.exceeded');
  });

  it('leaves a task inside its cap alone', async () => {
    const running = await runningPlan(h, singleTaskPlan());
    const taskId = running.taskIds['only'] as string;

    await report(running, taskId, { state: 'running' });
    h.clock.advanceMinutes(11);
    await heartbeat(h, running.supervisor.id);
    await tick(h.deps);

    expect(await taskState(h, taskId)).toBe('running');
  });
});

describe('status route authorisation', () => {
  it('refuses a task belonging to another plan', async () => {
    const first = await runningPlan(h, singleTaskPlan());
    const second = await runningPlan(h, {
      ...singleTaskPlan(),
      project: { name: 'other' },
    });

    const response = await h.app.inject({
      method: 'POST',
      url: `/plans/${first.planId}/tasks/${second.taskIds['only']}/status`,
      headers: bearer(first.planToken),
      payload: { state: 'running' },
    });

    expect(response.statusCode).toBe(403);
  });

  it('refuses a plan id that the token does not cover', async () => {
    const first = await runningPlan(h, singleTaskPlan());
    const second = await runningPlan(h, {
      ...singleTaskPlan(),
      project: { name: 'other' },
    });

    const response = await h.app.inject({
      method: 'POST',
      url: `/plans/${second.planId}/tasks/${second.taskIds['only']}/status`,
      headers: bearer(first.planToken),
      payload: { state: 'running' },
    });

    expect(response.statusCode).toBe(403);
  });

  it('refuses a token whose plan is no longer running', async () => {
    const running = await runningPlan(h, singleTaskPlan());
    await h.pool.query("UPDATE plans SET state = 'cancelled' WHERE id = $1", [running.planId]);

    const response = await report(running, running.taskIds['only'] as string, { state: 'running' });
    expect(response.statusCode).toBe(409);
  });

  it('refuses an unknown token', async () => {
    const running = await runningPlan(h, singleTaskPlan());
    const response = await report(running, running.taskIds['only'] as string, { state: 'running' }, 'nonsense');
    expect(response.statusCode).toBe(401);
  });

  it('rejects a malformed report', async () => {
    const running = await runningPlan(h, singleTaskPlan());
    const response = await report(running, running.taskIds['only'] as string, { state: 'sleeping' });
    expect(response.statusCode).toBe(400);
  });
});

describe('concurrent ticks', () => {
  it('claim disjoint tasks, so no task is dispatched twice', async () => {
    // Two tasks, matching the hardcoded default of 2 concurrent agents
    // (`max_concurrent_agents` is no longer a settable plan field — see the
    // skipped test above): both ticks race for both slots, and the property
    // under test — SKIP LOCKED claiming cannot double-dispatch a task — does
    // not depend on how many slots there are.
    const plan = {
      ...validPlan(),
      tasks: [
        { id: 'a', description: 'one', limits: { cost_microusd: 10, wall_clock_min: 5 } },
        { id: 'b', description: 'two', limits: { cost_microusd: 10, wall_clock_min: 5 } },
      ],
    };
    // Provision without dispatching, so both ticks race for both tasks.
    h.supervisors.taskThrows = true;
    const running = await runningPlan(h, plan);
    h.supervisors.taskThrows = false;

    await h.pool.query(
      "UPDATE tasks SET state = 'ready', dispatch_id = NULL, lease_expires_at = NULL WHERE plan_id = $1",
      [running.planId],
    );
    h.supervisors.taskDispatches.length = 0;

    await Promise.all([tick(h.deps), tick(h.deps)]);

    const dispatched = h.supervisors.taskDispatches.map((d) => d.request.task_id);
    expect(dispatched).toHaveLength(2);
    expect(new Set(dispatched).size).toBe(2);
  });
});
