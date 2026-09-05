import pg from 'pg';
import type { Pool, PoolClient } from 'pg';

const { Pool: PgPool, types } = pg;

// pg hands back int8 as a string to protect precision it cannot know we do not
// need. Event seq and the counters on tasks are all small, and every consumer
// wants a number, so parse them once here rather than at each call site.
types.setTypeParser(types.builtins.INT8, (value: string) => Number(value));

export function createPool(connectionString: string, max = 10): Pool {
  return new PgPool({ connectionString, max });
}

/**
 * Runs `fn` inside one transaction and rolls back if it throws. The client is
 * always released, including when the rollback itself fails.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection is already broken; the original error is the useful one.
    }
    throw error;
  } finally {
    client.release();
  }
}

export type { Pool, PoolClient };
