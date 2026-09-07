import type { Clock } from './clock.js';
import type { WorkerConfig } from './config.js';
import type { BrokerClient } from './broker.js';
import type { OrchestratorClient } from './orchestrator.js';
import type { TaskRunner } from './runner/runner.js';
import type { GitClient } from './tools/git.js';

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
  /**
   * The seam an agent framework sits behind: whatever turns a dispatch into a
   * `TaskOutcome`, whether that is the host-owned loop or something that owns
   * its own turn loop internally. `ModelTransport` (`transport/transport.ts`)
   * still exists underneath `HostLoopRunner`, but it is no longer part of
   * `Deps` — nothing above this seam needs to know it is there.
   */
  runner: TaskRunner;
  git: GitClient;
  /** Injected so retry backoff and the wall-clock limit run on the test clock. */
  sleep: (ms: number) => Promise<void>;
  log?: { warn?: (context: unknown, message: string) => void };
}
