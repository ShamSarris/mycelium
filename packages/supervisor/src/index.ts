import path from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { buildApp } from './app.js';
import { systemClock } from './clock.js';
import { loadConfig } from './config.js';
import { loadSecret } from './secrets.js';
import { HttpOrchestratorClient } from './clients/orchestrator.js';
import type { Deps } from './deps.js';
import { Ledger } from './environments/ledger.js';
import { ttlSweep } from './environments/teardown.js';
import { teardown } from './environments/teardown.js';
import { relayOnce } from './events/relay.js';
import { SeqCounters } from './events/seq.js';
import { Spool } from './events/spool.js';
import { SpoolEventSink } from './events/spoolSink.js';
import { heartbeatOnce } from './loops.js';
import { EgressProxy } from './proxy/connect.js';
import { reconcile } from './reconcile.js';
import { UnixSocketBroker } from './rpc/broker.js';
import { CgroupAgentRunner } from './drivers/cgroup.js';
import { DockerGvisorDriver } from './drivers/docker.js';
import { CliGitClient } from './drivers/git.js';

/**
 * Startup order is load-bearing:
 *
 * 1. Configuration, which refuses a wildcard bind (B19).
 * 2. The spool, so nothing is recorded before there is somewhere to put it.
 * 3. Reconciliation, which both cleans the VM and recovers the sequence
 *    counters. Nothing may emit an event until it has, so this retries rather
 *    than starting unarmed.
 * 4. Only then: listen, and start the periodic work.
 */
export async function main(): Promise<void> {
  const config = loadConfig();
  const token = loadSecret('supervisor_token');

  const spool = new Spool(path.join(config.stateDir, 'spool', 'events.jsonl'), config.spoolMaxBytes);
  await spool.open();

  const seq = new SeqCounters();
  const orchestrator = new HttpOrchestratorClient(
    config.orchestratorUrl,
    config.supervisorId,
    token,
  );

  // The broker and the proxy both need Deps, and Deps names both of them.
  // Forwarding through these two thunks breaks the cycle without making either
  // field optional everywhere else.
  let broker: UnixSocketBroker;
  let proxy: EgressProxy;

  const deps: Deps = {
    config,
    clock: systemClock,
    newId: uuidv7,
    ledger: new Ledger(),
    events: new SpoolEventSink({
      supervisorId: config.supervisorId,
      spool,
      seq,
      clock: systemClock,
      newId: uuidv7,
    }),
    containers: new DockerGvisorDriver({ captureMaxBytes: config.outputMaxBytes }),
    agents: new CgroupAgentRunner({
      command: (process.env.AGENT_COMMAND ?? '').split(' ').filter((part) => part.length > 0),
      ...(process.env.AGENT_SLICE === undefined ? {} : { slice: process.env.AGENT_SLICE }),
    }),
    git: new CliGitClient(),
    orchestrator,
    secret: loadSecret,
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    flushEvents: async () => {
      await relayOnce(spool, orchestrator);
    },
    log: console,
    broker: {
      listen: (planId, socketPath) => broker.listen(planId, socketPath),
      close: (planId) => broker.close(planId),
      closeAll: () => broker.closeAll(),
    },
    proxy: {
      listen: (planId, host, port) => proxy.listen(planId, host, port),
      close: (planId) => proxy.close(planId),
      closeAll: () => proxy.closeAll(),
    },
  };

  broker = new UnixSocketBroker(deps);
  proxy = new EgressProxy(deps);

  const spoolMarks = await spool.highestSeqByStream();
  while (true) {
    const result = await reconcile(deps, (marks) => seq.recover(spoolMarks, marks));
    if (result.armed) break;
    console.warn('reconciliation could not reach the orchestrator; retrying in 10s');
    await deps.sleep(10_000);
  }

  const app = buildApp(deps, { logger: true });
  await app.listen({ host: config.host, port: config.port });

  const timers = [
    setInterval(() => void heartbeatOnce(deps), config.heartbeatIntervalMs),
    setInterval(() => void relayOnce(spool, orchestrator), config.relayIntervalMs),
    setInterval(() => void ttlSweep(deps), 30_000),
  ];

  /**
   * The unit sets TimeoutStopSec=30s, comfortably above the 5 s teardown grace,
   * so systemd does not kill the supervisor mid-teardown and leave orphans for
   * the next start to find (baseline section 10).
   */
  const shutdown = async (): Promise<void> => {
    for (const timer of timers) clearInterval(timer);
    await app.close();
    for (const environment of deps.ledger.list()) {
      await teardown(deps, environment.planId, 'failed');
    }
    await broker.closeAll();
    await proxy.closeAll();
    await relayOnce(spool, orchestrator);
    await spool.close();
  };

  process.on('SIGTERM', () => void shutdown().then(() => process.exit(0)));
  process.on('SIGINT', () => void shutdown().then(() => process.exit(0)));
}

// Only when run as the entry point, so tests can import the module.
if (process.argv[1] !== undefined && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
