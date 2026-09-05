import type { Pool } from 'pg';
import type { Clock } from './clock.js';
import type { OrchestratorConfig } from './config.js';
import type { GiteaClient } from './clients/gitea.js';
import type { SupervisorClient } from './clients/supervisor.js';
import type { TokenCache } from './tokens.js';

/**
 * Everything the services need, passed explicitly. No singletons and no module
 * state, so `buildApp(deps)` can be called many times in one process and tests
 * can swap the clock and the two outbound clients.
 */
export interface Deps {
  pool: Pool;
  clock: Clock;
  newId: () => string;
  gitea: GiteaClient;
  supervisors: SupervisorClient;
  tokens: TokenCache;
  config: OrchestratorConfig;
}
