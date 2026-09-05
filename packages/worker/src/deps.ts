import type { Clock } from './clock.js';
import type { WorkerConfig } from './config.js';
import type { BrokerClient } from './broker.js';
import type { OrchestratorClient } from './orchestrator.js';
import type { GitClient } from './tools/git.js';
import type { ModelTransport } from './transport/transport.js';

/**
 * Everything the agent needs, passed explicitly — no singletons and no module
 * state, so a test builds its own agent with its own clock, transport, and
 * sockets. The same shape the orchestrator and the supervisor use.
 */
export interface Deps {
  config: WorkerConfig;
  clock: Clock;
  broker: BrokerClient;
  orchestrator: OrchestratorClient;
  /** The only seam a provider SDK is allowed behind. */
  transport: ModelTransport;
  git: GitClient;
  /** Injected so retry backoff and the wall-clock limit run on the test clock. */
  sleep: (ms: number) => Promise<void>;
  log?: { warn?: (context: unknown, message: string) => void };
}
