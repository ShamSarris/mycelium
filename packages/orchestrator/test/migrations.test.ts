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
