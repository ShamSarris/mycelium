import { SocketBrokerClient } from './broker.js';
import { systemClock } from './clock.js';
import { loadConfig } from './config.js';
import type { Deps } from './deps.js';
import { DispatchServer } from './dispatch.js';
import { CliGitClient } from './drivers/git.js';
import { HttpOrchestratorClient } from './orchestrator.js';
import { AgentSdkRunner } from './runner/agent-sdk.js';
import { shutdown, type TeardownReason } from './shutdown.js';
import { runDispatchedTask } from './task.js';

/**
 * The plan agent's entry point. The supervisor starts one of these per plan,
 * with the environment it injects, and signals it at teardown.
 *
 * Everything below is wiring. There is no work here and no decisions: the
 * process listens and then does nothing at all until a task arrives, because
 * an idle agent that polled would burn tokens for a plan that has none to
 * spare (baseline section 4, event-driven only).
 */
async function main(): Promise<void> {
  const config = loadConfig();

  const log = {
    warn: (context: unknown, message: string) => {
      // stderr, because the supervisor's spool is for events and this is for
      // the operator reading journalctl.
      console.error(JSON.stringify({ level: 'warn', plan_id: config.planId, message, context }));
    },
  };

  // `deps.runner` needs the rest of `deps` (it builds a fresh MCP server and
  // outcome box per task — see `AgentSdkRunner.run`), so `deps` is assembled
  // in two steps: everything else first, then the runner, which closes over
  // the finished object. The cast is safe because nothing reads `deps.runner`
  // until a task is actually dispatched, well after this function returns.
  const deps = {
    config,
    clock: systemClock,
    broker: new SocketBrokerClient(config.brokerSocket, config.brokerTimeoutMs, log),
    orchestrator: new HttpOrchestratorClient(
      config.orchestratorUrl,
      config.planId,
      config.credentials.orchestratorToken,
      config.orchestratorTimeoutMs,
    ),
    git: new CliGitClient(config.workdir, config.branch, config.credentials.giteaBotToken),
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    log,
  } as unknown as Deps;

  // Ticket 14: the Agent SDK runner is the only `TaskRunner` implementation
  // now that the host-owned loop is deleted.
  deps.runner = new AgentSdkRunner(deps);

  // One controller for the life of the process: a task's model call is what
  // teardown has to be able to interrupt, and there is only ever one task.
  const controller = new AbortController();

  const server = new DispatchServer(deps, (dispatch) =>
    runDispatchedTask(deps, dispatch, controller.signal),
  );

  await server.listen();

  let stopping = false;
  const stop = (reason: TeardownReason) => {
    // SIGTERM twice is the supervisor being thorough, not a second teardown.
    if (stopping) return;
    stopping = true;
    void shutdown({ deps, server, controller }, reason).then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };

  process.on('SIGTERM', () => stop('cancelled'));
  process.on('SIGINT', () => stop('cancelled'));
}

main().catch((error: unknown) => {
  // A configuration error is the likely cause, and it must be loud: an agent
  // that started half-configured would accept a task and fail it later, which
  // is strictly worse than never starting.
  console.error(`the plan agent could not start: ${(error as Error).message}`);
  process.exit(1);
});
