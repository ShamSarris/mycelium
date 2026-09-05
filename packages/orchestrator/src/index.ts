import { pathToFileURL } from 'node:url';
import pg from 'pg';
import type { Pool } from 'pg';
import { buildApp } from './app.js';
import { systemClock } from './clock.js';
import { loadConfig, type OrchestratorConfig } from './config.js';
import { HttpGiteaClient } from './clients/gitea.js';
import { HttpSupervisorClient } from './clients/supervisor.js';
import { createPool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { newId } from './db/uuid.js';
import type { Deps } from './deps.js';
import { tick } from './services/dispatcher.js';
import { TokenCache } from './tokens.js';

export { buildApp } from './app.js';
export { loadConfig } from './config.js';
export { runMigrations } from './db/migrate.js';
export { createPool, withTransaction } from './db/pool.js';
export { tick } from './services/dispatcher.js';
export { TokenCache } from './tokens.js';
export type { Deps } from './deps.js';

/**
 * Two orchestrators against one database would both claim leased tasks and
 * double-dispatch them, which is the failure hardest to diagnose from the event
 * log. The lock is session-scoped and held on its own connection for the life
 * of the process.
 */
export async function acquireSingleWriterLock(config: OrchestratorConfig): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: config.databaseUrl });
  await client.connect();

  const { rows } = await client.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_lock(hashtext('mycelium-orchestrator')) AS locked",
  );

  if (rows[0]?.locked !== true) {
    await client.end();
    throw new Error(
      'another orchestrator holds the single-writer advisory lock on this database',
    );
  }

  return client;
}

export interface DispatcherHandle {
  stop(): Promise<void>;
}

/**
 * The interval is the guarantee that work progresses; the LISTEN notification
 * is only a hint that shortens the wait (baseline section 6).
 */
export async function startDispatcher(deps: Deps): Promise<DispatcherHandle> {
  let running = false;
  let stopped = false;

  const runOnce = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      await tick(deps);
    } catch (error) {
      // A failing tick must not kill the loop: the next one re-reads state.
      console.error('dispatcher tick failed', error);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void runOnce(), deps.config.dispatcherIntervalMs);
  timer.unref();

  const listener = new pg.Client({ connectionString: deps.config.databaseUrl });
  await listener.connect();
  await listener.query('LISTEN mycelium_wake');
  listener.on('notification', () => void runOnce());

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await listener.end().catch(() => undefined);
    },
  };
}

export function buildDeps(config: OrchestratorConfig, pool: Pool): Deps {
  return {
    pool,
    clock: systemClock,
    newId,
    gitea: new HttpGiteaClient(config.gitea),
    supervisors: new HttpSupervisorClient(),
    tokens: new TokenCache(),
    config,
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);

  await runMigrations(pool, config.migrationsDir);
  const lock = await acquireSingleWriterLock(config);

  const deps = buildDeps(config, pool);
  const app = buildApp(deps, { logger: true });

  await app.listen({ port: config.port, host: config.host });
  const dispatcher = await startDispatcher(deps);

  const shutdown = async (): Promise<void> => {
    await dispatcher.stop();
    await app.close();
    await lock.end().catch(() => undefined);
    await pool.end();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

// Only run when executed directly, so importing this module in a test or a
// future MCP adapter does not start a server. pathToFileURL rather than string
// concatenation: a Windows path produces file:///C:/... , not file://C:/... .
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
