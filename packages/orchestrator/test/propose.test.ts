import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, operatorHeaders, type TestHarness } from './helpers/app.js';
import { propose, validPlan } from './helpers/fixtures.js';

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

async function post(
  payload: Record<string, unknown>,
  headers: Record<string, string> = operatorHeaders(),
) {
  return h.app.inject({ method: 'POST', url: '/plans', headers, payload });
}

describe('POST /plans - a valid plan', () => {
  it('stores the plan as proposed', async () => {
    const response = await post(validPlan());
    expect(response.statusCode).toBe(201);

    const body = response.json();
    expect(body.state).toBe('proposed');

    const { rows } = await h.pool.query('SELECT state::text AS state FROM plans WHERE id = $1', [
      body.plan_id,
    ]);
    expect(rows[0]?.state).toBe('proposed');
  });

  it('stores every task as pending', async () => {
    const { plan_id } = await propose(h);
    const { rows } = await h.pool.query<{ state: string; local_id: string }>(
      'SELECT state::text AS state, local_id FROM tasks WHERE plan_id = $1 ORDER BY local_id',
      [plan_id],
    );
    expect(rows.map((r) => r.local_id)).toEqual(['a-write-tests', 'b-implement']);
    expect(rows.every((r) => r.state === 'pending')).toBe(true);
  });

  it('records the dependency edges', async () => {
    const { plan_id } = await propose(h);
    const { rows } = await h.pool.query<{ from_local: string; to_local: string }>(
      `SELECT t.local_id AS from_local, d.local_id AS to_local
         FROM task_dependencies e
         JOIN tasks t ON t.id = e.task_id
         JOIN tasks d ON d.id = e.depends_on_task_id
        WHERE t.plan_id = $1`,
      [plan_id],
    );
    expect(rows).toEqual([{ from_local: 'b-implement', to_local: 'a-write-tests' }]);
  });

  it('creates the project and asks Gitea for the repo exactly once', async () => {
    const { project_id } = await propose(h);
    expect(h.gitea.ensureRepoCalls).toEqual(['demo']);

    const { rows } = await h.pool.query<{ name: string; gitea_repo: string | null }>(
      'SELECT name, gitea_repo FROM projects WHERE id = $1',
      [project_id],
    );
    expect(rows[0]).toEqual({ name: 'demo', gitea_repo: 'demo' });
  });

  it('echoes the assumptions and the declared egress for the approval gate', async () => {
    const plan = { ...validPlan(), egress: ['example.com', '*.cdn.example.com'] };
    const response = await post(plan);
    const body = response.json();

    expect(body.assumptions).toEqual(['The orchestrator already has a Fastify instance.']);
    expect(body.egress).toEqual(['example.com', '*.cdn.example.com']);
  });

  it('defaults egress to empty, which denies everything outside the standing set', async () => {
    const response = await post(validPlan());
    expect(response.json().egress).toEqual([]);
  });

  it('writes an operator.action event naming who proposed it', async () => {
    const { plan_id } = await propose(h);
    const { rows } = await h.pool.query<{ payload: { action: string; operator: string } }>(
      "SELECT payload FROM events WHERE plan_id = $1 AND type = 'operator.action'",
      [plan_id],
    );
    expect(rows[0]?.payload).toMatchObject({ action: 'propose_plan', operator: 'sam@example.com' });
  });

  it('writes the initial plan.state_changed event', async () => {
    const { plan_id } = await propose(h);
    const { rows } = await h.pool.query<{ payload: { from: null; to: string } }>(
      "SELECT payload FROM events WHERE plan_id = $1 AND type = 'plan.state_changed'",
      [plan_id],
    );
    expect(rows[0]?.payload).toEqual({ from: null, to: 'proposed', reason: 'proposed' });
  });
});

describe('POST /plans - projects', () => {
  it('reuses an existing project referenced by id, without creating a second repo', async () => {
    const first = await propose(h);
    h.gitea.ensureRepoCalls.length = 0;

    const second = await propose(h, { ...validPlan(), project: { id: first.project_id } });

    expect(second.project_id).toBe(first.project_id);
    expect(h.gitea.ensureRepoCalls).toEqual([]);
  });

  it('reuses an existing project referenced by name', async () => {
    const first = await propose(h);
    const second = await propose(h);
    expect(second.project_id).toBe(first.project_id);
  });

  it('returns 404 for an unknown project id and writes nothing', async () => {
    const response = await post({
      ...validPlan(),
      project: { id: '018f3a5c-0000-7000-8000-0000000000ff' },
    });

    expect(response.statusCode).toBe(404);
    const { rows } = await h.pool.query('SELECT count(*)::int AS n FROM plans');
    expect(rows[0]?.n).toBe(0);
  });

  it('leaves the plan proposed with no repo when Gitea fails, so approve can retry', async () => {
    h.gitea.throwAlways.add('ensureRepo');
    const response = await post(validPlan());
    expect(response.statusCode).toBe(201);

    const { rows } = await h.pool.query<{ gitea_repo: string | null }>(
      'SELECT gitea_repo FROM projects WHERE id = $1',
      [response.json().project_id],
    );
    expect(rows[0]?.gitea_repo).toBeNull();

    const { rows: errors } = await h.pool.query<{ payload: { stage: string } }>(
      "SELECT payload FROM events WHERE type = 'error'",
    );
    expect(errors[0]?.payload.stage).toBe('ensure_repo');
  });
});

describe('POST /plans - rejection', () => {
  it('rejects a plan that fails the schema and writes no rows', async () => {
    const response = await post({ ...validPlan(), assumptions: [] });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('invalid_plan');
    expect(response.json().error.issues.length).toBeGreaterThan(0);

    const { rows } = await h.pool.query('SELECT count(*)::int AS n FROM plans');
    expect(rows[0]?.n).toBe(0);
  });

  it('rejects a dependency cycle', async () => {
    const response = await post({
      ...validPlan(),
      tasks: [
        {
          id: 'a',
          description: 'first',
          depends_on: ['b'],
          limits: { tokens: 10, wall_clock_min: 1 },
        },
        {
          id: 'b',
          description: 'second',
          depends_on: ['a'],
          limits: { tokens: 10, wall_clock_min: 1 },
        },
      ],
    });

    expect(response.statusCode).toBe(400);
    const codes = response.json().error.issues.map((i: { code: string }) => i.code);
    expect(codes).toContain('dependency_cycle');
  });

  it('rejects a dependency on a task that does not exist', async () => {
    const response = await post({
      ...validPlan(),
      tasks: [
        {
          id: 'a',
          description: 'first',
          depends_on: ['nope'],
          limits: { tokens: 10, wall_clock_min: 1 },
        },
      ],
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects an egress entry carrying a scheme', async () => {
    const response = await post({ ...validPlan(), egress: ['https://example.com'] });
    expect(response.statusCode).toBe(400);
  });
});

describe('POST /plans - operator identity', () => {
  it('returns 401 without a Tailscale identity header', async () => {
    const response = await post(validPlan(), {});
    expect(response.statusCode).toBe(401);
  });

  it('returns 403 for an identity that is not on the allowlist', async () => {
    const response = await post(validPlan(), { 'tailscale-user-login': 'stranger@example.com' });
    expect(response.statusCode).toBe(403);
  });

  it('writes nothing when the caller is rejected', async () => {
    await post(validPlan(), {});
    const { rows } = await h.pool.query('SELECT count(*)::int AS n FROM projects');
    expect(rows[0]?.n).toBe(0);
  });
});
