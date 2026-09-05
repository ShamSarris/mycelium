import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { buildApp } from '../../src/app.js';
import { loadConfig, type OrchestratorConfig } from '../../src/config.js';
import { newId } from '../../src/db/uuid.js';
import type { Deps } from '../../src/deps.js';
import { TokenCache } from '../../src/tokens.js';
import { FakeGiteaClient, FakeSupervisorClient, MutableClock } from './fakes.js';
import { MIGRATIONS_DIR, TEST_DATABASE_URL, resetDatabase, testPool } from './db.js';

export const OPERATOR = 'sam@example.com';

export interface TestHarness {
  app: FastifyInstance;
  pool: Pool;
  deps: Deps;
  clock: MutableClock;
  gitea: FakeGiteaClient;
  supervisors: FakeSupervisorClient;
  config: OrchestratorConfig;
  /** Truncates every table and clears the recorded fake calls. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function buildTestApp(
  overrides: Partial<OrchestratorConfig> = {},
): Promise<TestHarness> {
  const pool = await testPool();

  const config: OrchestratorConfig = {
    ...loadConfig({
      DATABASE_URL: TEST_DATABASE_URL,
      OPERATOR_ALLOWLIST: OPERATOR,
      MIGRATIONS_DIR,
    }),
    ...overrides,
  };

  const clock = new MutableClock();
  const gitea = new FakeGiteaClient();
  const supervisors = new FakeSupervisorClient();

  const deps: Deps = {
    pool,
    clock,
    newId,
    gitea,
    supervisors,
    tokens: new TokenCache(),
    config,
  };

  const app = buildApp(deps);
  await app.ready();

  return {
    app,
    pool,
    deps,
    clock,
    gitea,
    supervisors,
    config,
    async reset() {
      await resetDatabase(pool);
      gitea.ensureRepoCalls.length = 0;
      gitea.createBranchCalls.length = 0;
      gitea.createBotTokenCalls.length = 0;
      gitea.revokeCalls.length = 0;
      gitea.fileExistsCalls.length = 0;
      gitea.openPullRequestCalls.length = 0;
      gitea.throwOnce.clear();
      gitea.throwAlways.clear();
      gitea.fileExistsResult = true;
      gitea.pullRequestUrl = 'http://gitea.local/mycelium/demo/pulls/1';
      supervisors.planDispatches.length = 0;
      supervisors.taskDispatches.length = 0;
      supervisors.teardowns.length = 0;
      supervisors.planResponses.clear();
      supervisors.defaultPlanResponse = { accepted: true };
      supervisors.taskAccepted = true;
      supervisors.taskThrows = false;
      supervisors.teardownThrows = false;
      clock.set(new Date('2026-09-02T12:00:00.000Z'));
      deps.tokens.clear();
    },
    async close() {
      await app.close();
      await pool.end();
    },
  };
}

/** Headers that pass the operator gate. */
export function operatorHeaders(login: string = OPERATOR): Record<string, string> {
  return { 'tailscale-user-login': login };
}

export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}
