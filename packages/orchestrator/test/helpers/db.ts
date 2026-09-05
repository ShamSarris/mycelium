import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { createPool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(HERE, '../../../../migrations');

/**
 * Tests run against a real Postgres 17 (docker compose up -d). The queue
 * semantics under test - FOR UPDATE SKIP LOCKED, advisory locks, the
 * append-only trigger - do not exist in any substitute.
 */
export const TEST_DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://mycelium:mycelium@localhost:5433/mycelium';

export async function testPool(): Promise<Pool> {
  const pool = createPool(TEST_DATABASE_URL, 8);
  await runMigrations(pool, MIGRATIONS_DIR);
  return pool;
}

/**
 * TRUNCATE rather than DELETE: it does not fire the append-only row trigger on
 * events, so the log stays immutable in production and disposable in tests.
 */
export async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query(
    'TRUNCATE events, task_dependencies, tasks, plans, agents, projects RESTART IDENTITY CASCADE',
  );
  await pool.query('ALTER SEQUENCE orchestrator_seq RESTART');
}
