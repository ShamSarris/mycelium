import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { runMigrations } from '../src/db/migrate.js';
import { withTransaction } from '../src/db/pool.js';
import { newId } from '../src/db/uuid.js';
import { MIGRATIONS_DIR, resetDatabase, testPool } from './helpers/db.js';

let pool: Pool;

beforeAll(async () => {
  pool = await testPool();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await resetDatabase(pool);
});

describe('migration runner', () => {
  it('has applied every file in the migrations directory', async () => {
    const { rows } = await pool.query<{ name: string }>(
      'SELECT name FROM schema_migrations ORDER BY name',
    );
    expect(rows.map((r) => r.name)).toContain('0001_init.sql');
  });

  it('is idempotent, so a restart does not re-run anything', async () => {
    const ran = await runMigrations(pool, MIGRATIONS_DIR);
    expect(ran).toEqual([]);
  });

  it('created every table the baseline names', async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name`,
    );
    const tables = rows.map((r) => r.table_name);
    for (const table of [
      'agents',
      'events',
      'plans',
      'projects',
      'schema_migrations',
      'task_dependencies',
      'tasks',
    ]) {
      expect(tables, table).toContain(table);
    }
  });
});

describe('0004_cost_budgets', () => {
  let migrationSql: string;

  beforeAll(async () => {
    migrationSql = await readFile(path.join(MIGRATIONS_DIR, '0004_cost_budgets.sql'), 'utf8');
  });

  /** Inserts a project + plan with the given (already-JSON) spec. */
  async function seedPlan(spec: Record<string, unknown>): Promise<{ planId: string }> {
    const projectId = newId();
    const planId = newId();
    await pool.query('INSERT INTO projects (id, name, created_at) VALUES ($1, $2, now())', [
      projectId,
      `proj-${projectId.slice(0, 8)}`,
    ]);
    await pool.query(
      `INSERT INTO plans (id, project_id, state, env, spec, proposed_at, proposed_by, updated_at)
       VALUES ($1, $2, 'proposed', 'dev', $3, now(), 'tester', now())`,
      [planId, projectId, JSON.stringify(spec)],
    );
    return { planId };
  }

  /** Inserts a task row under `planId`, optionally seeding cost_spent_microusd. */
  async function seedTask(
    planId: string,
    localId: string,
    spec: Record<string, unknown>,
    costSpentMicrousd: number | bigint = 0,
  ): Promise<string> {
    const taskId = newId();
    await pool.query(
      `INSERT INTO tasks (id, plan_id, local_id, state, spec, cost_spent_microusd, updated_at)
       VALUES ($1, $2, $3, 'pending', $4, $5, now())`,
      [taskId, planId, localId, JSON.stringify(spec), String(costSpentMicrousd)],
    );
    return taskId;
  }

  it('adds tasks.cost_spent_microusd as bigint NOT NULL DEFAULT 0', async () => {
    const { rows } = await pool.query<{
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'tasks' AND column_name = 'cost_spent_microusd'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data_type).toBe('bigint');
    expect(rows[0]?.is_nullable).toBe('NO');
    expect(rows[0]?.column_default).toContain('0');
  });

  it('leaves tasks.tokens_spent as integer, unchanged', async () => {
    const { rows } = await pool.query<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns
        WHERE table_name = 'tasks' AND column_name = 'tokens_spent'`,
    );
    expect(rows[0]?.data_type).toBe('integer');
  });

  it('stores and reads back a value past the int4 ceiling exactly', async () => {
    const { planId } = await seedPlan({ max_cost_microusd: 1 });
    const taskId = await seedTask(planId, 'only', {}, 3_000_000_000);

    // The pool's INT8 type parser (src/db/pool.ts) converts bigint to a JS
    // number for every consumer's convenience; 3_000_000_000 is well inside
    // Number.MAX_SAFE_INTEGER so no precision is lost.
    const { rows } = await pool.query<{ cost: number }>(
      'SELECT cost_spent_microusd AS cost FROM tasks WHERE id = $1',
      [taskId],
    );
    expect(rows[0]?.cost).toBe(3_000_000_000);
  });

  it('sums past the int4 ceiling under ::bigint but overflows under ::int', async () => {
    const { planId } = await seedPlan({ max_cost_microusd: 1 });
    await seedTask(planId, 'one', {}, 1_500_000_000);
    await seedTask(planId, 'two', {}, 1_500_000_000);

    const bigintSum = await pool.query<{ total: number }>(
      'SELECT sum(cost_spent_microusd)::bigint AS total FROM tasks WHERE plan_id = $1',
      [planId],
    );
    expect(bigintSum.rows[0]?.total).toBe(3_000_000_000);

    await expect(
      pool.query('SELECT sum(cost_spent_microusd)::int AS total FROM tasks WHERE plan_id = $1', [
        planId,
      ]),
    ).rejects.toThrow(/out of range/i);
  });

  it('rewrites an old-shape plans.spec to the new field names', async () => {
    const { planId } = await seedPlan({
      max_tokens: 500000,
      max_concurrent_agents: 3,
      tasks: [
        { id: 'a', limits: { tokens: 50000, wall_clock_min: 20 } },
        { id: 'b', limits: { tokens: 100000, wall_clock_min: 30 } },
      ],
    });

    await pool.query(migrationSql);

    const { rows } = await pool.query<{ spec: Record<string, any> }>(
      'SELECT spec FROM plans WHERE id = $1',
      [planId],
    );
    const spec = rows[0]?.spec;
    expect(spec?.max_cost_microusd).toBe(500000);
    expect(spec?.max_tokens).toBeUndefined();
    expect(spec?.max_concurrent_agents).toBeUndefined();
    expect(spec?.tasks[0].limits.cost_microusd).toBe(50000);
    expect(spec?.tasks[0].limits.tokens).toBeUndefined();
    expect(spec?.tasks[1].limits.cost_microusd).toBe(100000);
  });

  it('rewrites an old-shape tasks.spec to the new field name', async () => {
    const { planId } = await seedPlan({ max_cost_microusd: 1 });
    const taskId = await seedTask(planId, 'only', {
      limits: { tokens: 20000, wall_clock_min: 10 },
    });

    await pool.query(migrationSql);

    const { rows } = await pool.query<{ spec: Record<string, any> }>(
      'SELECT spec FROM tasks WHERE id = $1',
      [taskId],
    );
    expect(rows[0]?.spec.limits.cost_microusd).toBe(20000);
    expect(rows[0]?.spec.limits.tokens).toBeUndefined();
  });

  it('deletes a plan whose spec has neither max_tokens nor max_cost_microusd', async () => {
    // A malformed row: no plan-wide ceiling under either name, and no price
    // table exists to invent one. See migration comment for the decision.
    const { planId } = await seedPlan({ tasks: [] });

    await pool.query(migrationSql);

    const { rows } = await pool.query('SELECT id FROM plans WHERE id = $1', [planId]);
    expect(rows).toHaveLength(0);
  });

  it('leaves plans.manifest untouched — historical tokens_spent totals are not rewritten', async () => {
    const { planId } = await seedPlan({
      max_tokens: 1000,
      tasks: [{ id: 'a', limits: { tokens: 1000, wall_clock_min: 5 } }],
    });
    await pool.query('UPDATE plans SET manifest = $2 WHERE id = $1', [
      planId,
      JSON.stringify({ spend: { tokens_spent: 1000 } }),
    ]);

    await pool.query(migrationSql);

    const { rows } = await pool.query<{ manifest: Record<string, any> }>(
      'SELECT manifest FROM plans WHERE id = $1',
      [planId],
    );
    expect(rows[0]?.manifest).toEqual({ spend: { tokens_spent: 1000 } });
  });

  it('is idempotent — applying it twice changes nothing the second time', async () => {
    const { planId } = await seedPlan({
      max_tokens: 10000,
      tasks: [{ id: 'a', limits: { tokens: 1000, wall_clock_min: 5 } }],
    });
    const taskId = await seedTask(planId, 'a', { limits: { tokens: 1000, wall_clock_min: 5 } });

    await pool.query(migrationSql);
    const firstPlan = await pool.query('SELECT spec FROM plans WHERE id = $1', [planId]);
    const firstTask = await pool.query('SELECT spec FROM tasks WHERE id = $1', [taskId]);

    await expect(pool.query(migrationSql)).resolves.toBeDefined();

    const secondPlan = await pool.query('SELECT spec FROM plans WHERE id = $1', [planId]);
    const secondTask = await pool.query('SELECT spec FROM tasks WHERE id = $1', [taskId]);
    expect(secondPlan.rows[0]?.spec).toEqual(firstPlan.rows[0]?.spec);
    expect(secondTask.rows[0]?.spec).toEqual(firstTask.rows[0]?.spec);
  });
});

describe('resetDatabase', () => {
  it('leaves every table empty', async () => {
    await pool.query(
      'INSERT INTO projects (id, name, created_at) VALUES ($1, $2, now())',
      [newId(), 'scratch'],
    );
    await resetDatabase(pool);

    const { rows } = await pool.query<{ n: string }>('SELECT count(*) AS n FROM projects');
    expect(Number(rows[0]?.n)).toBe(0);
  });
});

describe('append-only events', () => {
  async function insertEvent(): Promise<string> {
    const id = newId();
    await pool.query(
      `INSERT INTO events (event_id, ts, received_at, source, stream_id, seq, type, payload)
       VALUES ($1, now(), now(), 'orchestrator', 'orchestrator', nextval('orchestrator_seq'),
               'error', '{}'::jsonb)`,
      [id],
    );
    return id;
  }

  it('rejects an UPDATE', async () => {
    const id = await insertEvent();
    await expect(
      pool.query("UPDATE events SET type = 'operator.action' WHERE event_id = $1", [id]),
    ).rejects.toThrow(/append-only/);
  });

  it('rejects a DELETE', async () => {
    const id = await insertEvent();
    await expect(pool.query('DELETE FROM events WHERE event_id = $1', [id])).rejects.toThrow(
      /append-only/,
    );
  });

  it('rejects a second event reusing a stream and seq', async () => {
    await pool.query(
      `INSERT INTO events (event_id, ts, received_at, source, stream_id, seq, type, payload)
       VALUES ($1, now(), now(), 'supervisor', 'sup-1', 7, 'error', '{}'::jsonb)`,
      [newId()],
    );
    await expect(
      pool.query(
        `INSERT INTO events (event_id, ts, received_at, source, stream_id, seq, type, payload)
         VALUES ($1, now(), now(), 'supervisor', 'sup-1', 7, 'error', '{}'::jsonb)`,
        [newId()],
      ),
    ).rejects.toThrow();
  });
});

describe('newId', () => {
  it('mints version 7 uuids', () => {
    expect(newId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('sorts lexically in creation order, which is why the indexes stay compact', async () => {
    const first = newId();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = newId();
    expect([second, first].sort()).toEqual([first, second]);
  });

  it('does not repeat', () => {
    const ids = new Set(Array.from({ length: 500 }, newId));
    expect(ids.size).toBe(500);
  });
});

describe('withTransaction', () => {
  it('commits when the callback returns', async () => {
    const id = newId();
    await withTransaction(pool, async (client) => {
      await client.query('INSERT INTO projects (id, name, created_at) VALUES ($1, $2, now())', [
        id,
        'committed',
      ]);
    });
    const { rows } = await pool.query('SELECT id FROM projects WHERE id = $1', [id]);
    expect(rows).toHaveLength(1);
  });

  it('rolls back when the callback throws', async () => {
    const id = newId();
    await expect(
      withTransaction(pool, async (client) => {
        await client.query('INSERT INTO projects (id, name, created_at) VALUES ($1, $2, now())', [
          id,
          'rolled-back',
        ]);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const { rows } = await pool.query('SELECT id FROM projects WHERE id = $1', [id]);
    expect(rows).toHaveLength(0);
  });
});
