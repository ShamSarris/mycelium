import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';

/**
 * Applies every `NNNN_*.sql` file in `dir` that has not run yet, in filename
 * order, each in its own transaction. Roll forward only: at single-operator
 * scale a bad migration is corrected by the next one, never undone.
 */
export async function runMigrations(pool: Pool, dir: string): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const entries = await readdir(dir);
  const files = entries.filter((f) => f.endsWith('.sql')).sort();

  const { rows } = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));

  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = await readFile(path.join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      ran.push(file);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw new Error(`migration ${file} failed: ${(error as Error).message}`, { cause: error });
    } finally {
      client.release();
    }
  }

  return ran;
}
