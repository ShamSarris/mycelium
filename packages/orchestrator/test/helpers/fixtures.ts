import { expect } from 'vitest';
import { hashToken, mintToken } from '../../src/tokens.js';
import { tick } from '../../src/services/dispatcher.js';
import type { TestHarness } from './app.js';
import { OPERATOR, operatorHeaders } from './app.js';

/** The smallest plan that satisfies baseline section 6, as a mutable object. */
export function validPlan(): Record<string, unknown> {
  return {
    goal: 'Add a health endpoint to the orchestrator.',
    project: { name: 'demo' },
    assumptions: ['The orchestrator already has a Fastify instance.'],
    env: 'dev',
    tasks: [
      {
        id: 'a-write-tests',
        description: 'Write failing tests for GET /healthz.',
        limits: { tokens: 50000, wall_clock_min: 20 },
      },
      {
        id: 'b-implement',
        description: 'Implement GET /healthz until the tests pass.',
        depends_on: ['a-write-tests'],
        limits: { tokens: 100000, wall_clock_min: 30 },
      },
    ],
    success_criteria: [{ type: 'all_tasks_done' }],
  };
}

/** A single-task plan, for tests that do not care about the DAG. */
export function singleTaskPlan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...validPlan(),
    tasks: [
      {
        id: 'only',
        description: 'Do the one thing.',
        limits: { tokens: 1000, wall_clock_min: 10 },
      },
    ],
    ...overrides,
  };
}

export async function propose(
  h: TestHarness,
  plan: Record<string, unknown> = validPlan(),
): Promise<{ plan_id: string; project_id: string }> {
  const response = await h.app.inject({
    method: 'POST',
    url: '/plans',
    headers: operatorHeaders(),
    payload: plan,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json();
}

export async function approve(h: TestHarness, planId: string): Promise<void> {
  const response = await h.app.inject({
    method: 'POST',
    url: `/plans/${planId}/approve`,
    headers: operatorHeaders(),
  });
  expect(response.statusCode, response.body).toBe(200);
}

export interface RegisteredSupervisor {
  id: string;
  name: string;
  token: string;
}

/**
 * Inserts an agents row directly. Registration is an operator act performed by
 * a script, not an API, so there is no route to go through.
 */
export async function registerSupervisor(
  h: TestHarness,
  options: {
    name?: string;
    env?: 'dev' | 'prod';
    priority?: number;
    enabled?: boolean;
    heartbeatAt?: Date | null;
  } = {},
): Promise<RegisteredSupervisor> {
  const id = crypto.randomUUID();
  const token = mintToken();
  const name = options.name ?? `worker-${id.slice(0, 8)}`;
  const heartbeat =
    options.heartbeatAt === undefined ? h.clock.now() : options.heartbeatAt;

  await h.pool.query(
    `INSERT INTO agents (id, name, env, base_url, token_hash, enabled, priority,
                         last_heartbeat_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      name,
      options.env ?? 'dev',
      `http://${name}.tailnet:8080`,
      hashToken(token),
      options.enabled ?? true,
      options.priority ?? 100,
      heartbeat,
      h.clock.now(),
    ],
  );

  return { id, name, token };
}

export interface RunningPlan {
  planId: string;
  projectId: string;
  supervisor: RegisteredSupervisor;
  /** The per-plan orchestrator API token, as the supervisor received it. */
  planToken: string;
  taskIds: Record<string, string>;
}

/** Propose, approve, register one healthy supervisor, and tick until running. */
export async function runningPlan(
  h: TestHarness,
  plan: Record<string, unknown> = validPlan(),
): Promise<RunningPlan> {
  const supervisor = await registerSupervisor(h);
  const { plan_id, project_id } = await propose(h, plan);
  await approve(h, plan_id);
  await tick(h.deps);

  const planToken = h.deps.tokens.get(plan_id)?.orchestratorToken ?? '';
  const { rows } = await h.pool.query<{ id: string; local_id: string }>(
    'SELECT id, local_id FROM tasks WHERE plan_id = $1',
    [plan_id],
  );

  const taskIds: Record<string, string> = {};
  for (const row of rows) taskIds[row.local_id] = row.id;

  return { planId: plan_id, projectId: project_id, supervisor, planToken, taskIds };
}

/** Keeps a supervisor healthy while a test advances the clock. */
export async function heartbeat(h: TestHarness, supervisorId: string): Promise<void> {
  await h.pool.query('UPDATE agents SET last_heartbeat_at = $2 WHERE id = $1', [
    supervisorId,
    h.clock.now(),
  ]);
}

export async function planState(h: TestHarness, planId: string): Promise<string> {
  const { rows } = await h.pool.query<{ state: string }>(
    'SELECT state::text AS state FROM plans WHERE id = $1',
    [planId],
  );
  return rows[0]?.state ?? 'missing';
}

export async function taskState(h: TestHarness, taskId: string): Promise<string> {
  const { rows } = await h.pool.query<{ state: string }>(
    'SELECT state::text AS state FROM tasks WHERE id = $1',
    [taskId],
  );
  return rows[0]?.state ?? 'missing';
}

export async function eventTypes(h: TestHarness, planId: string): Promise<string[]> {
  const { rows } = await h.pool.query<{ type: string }>(
    'SELECT type FROM events WHERE plan_id = $1 ORDER BY seq',
    [planId],
  );
  return rows.map((r) => r.type);
}

export { OPERATOR, operatorHeaders };
