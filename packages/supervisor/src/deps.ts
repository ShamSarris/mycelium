import type { Clock } from './clock.js';
import type { SupervisorConfig } from './config.js';
import type { ContainerDriver } from './drivers/container.js';
import type { AgentRunner } from './drivers/process.js';
import type { GitClient } from './drivers/git.js';
import type { OrchestratorClient } from './clients/orchestrator.js';
import type { Ledger } from './environments/ledger.js';
import type { EventSink } from './events/sink.js';
import type { Broker } from './rpc/broker.js';
import type { ProxyListener } from './proxy/connect.js';

/**
 * Everything the supervisor needs, passed explicitly — no singletons and no
 * module state, so `buildApp(deps)` can be built many times in one process and
 * every test gets its own clock, ledger, and drivers.
 */
export interface Deps {
  config: SupervisorConfig;
  clock: Clock;
  newId: () => string;
  ledger: Ledger;
  events: EventSink;
  /** The per-plan RPC socket the agent reaches the supervisor through (B20). */
  broker: Broker;
  /** The per-plan egress proxy that enforces the plan's allowlist (B14). */
  proxy: ProxyListener;
  containers: ContainerDriver;
  agents: AgentRunner;
  git: GitClient;
  orchestrator: OrchestratorClient;
  /** Resolves a long-lived secret. Injected so tests do not touch the filesystem. */
  secret: (name: string) => string;
  /** Injected so the teardown grace runs on the test clock rather than in real time. */
  sleep: (ms: number) => Promise<void>;
  /** Drains the spool once. Called during teardown so a terminal event lands. */
  flushEvents: () => Promise<void>;
  log?: { warn?: (context: unknown, message: string) => void };
}
