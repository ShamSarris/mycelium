import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { v7 as uuidv7 } from 'uuid';
import { buildApp } from '../../src/app.js';
import { loadConfig, type SupervisorConfig } from '../../src/config.js';
import type { Deps } from '../../src/deps.js';
import { Ledger } from '../../src/environments/ledger.js';
import {
  FakeAgentHandle,
  FakeBroker,
  FakeProxy,
  FakeAgentRunner,
  FakeContainerDriver,
  FakeGitClient,
  FakeOrchestratorClient,
  MutableClock,
  RecordingEventSink,
} from './fakes.js';

export const ORCHESTRATOR_PEER = '100.64.0.1';
export const SUPERVISOR_ID = '018f3a5c-0000-7000-8000-000000000001';

export interface TestHarness {
  app: FastifyInstance;
  deps: Deps;
  config: SupervisorConfig;
  clock: MutableClock;
  ledger: Ledger;
  events: RecordingEventSink;
  broker: FakeBroker;
  proxy: FakeProxy;
  containers: FakeContainerDriver;
  agents: FakeAgentRunner;
  git: FakeGitClient;
  orchestrator: FakeOrchestratorClient;
  stateDir: string;
  /** When teardown drained the spool. */
  flushes: Date[];
  /** POST a plan dispatch, defaulting the body and the peer to valid ones. */
  dispatch(options?: {
    remoteAddress?: string;
    payload?: Record<string, unknown>;
  }): Promise<LightMyRequestResponse>;
  inject(options: InjectOptions): Promise<LightMyRequestResponse>;
  /** Puts a live environment in the ledger without going through provisioning. */
  provisionEnvironment(planId: string, overrides?: Partial<{ egress: string[] }>): FakeAgentHandle;
  reset(): void;
  close(): Promise<void>;
}

export function planDispatch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    plan_id: '018f3a5c-0000-7000-8000-00000000000a',
    project: { id: '018f3a5c-0000-7000-8000-0000000000b0', name: 'demo' },
    gitea: {
      repo_url: 'http://gitea.tailnet/mycelium/demo.git',
      branch: 'plan/018f3a5c-0000-7000-8000-00000000000a',
      bot_token: 'gitea-bot-token',
    },
    orchestrator_token: 'per-plan-token',
    egress: ['api.github.com'],
    max_concurrent_agents: 2,
    env_ttl_min: 240,
    ...overrides,
  };
}

export async function buildTestApp(
  overrides: Partial<SupervisorConfig> = {},
): Promise<TestHarness> {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'mycelium-supervisor-'));

  const config: SupervisorConfig = {
    ...loadConfig({
      SUPERVISOR_ID,
      ORCHESTRATOR_URL: 'http://orchestrator.tailnet:8080',
      ORCHESTRATOR_PEERS: ORCHESTRATOR_PEER,
      HOST: '127.0.0.1',
      STATE_DIR: stateDir,
      SANDBOX_IMAGES: 'node:22-alpine,python:3.13-slim',
      STANDING_EGRESS: 'gitea.tailnet,registry.npmjs.org',
    }),
    ...overrides,
  };

  const clock = new MutableClock();
  const ledger = new Ledger();
  const events = new RecordingEventSink();
  const broker = new FakeBroker();
  const proxy = new FakeProxy();
  const containers = new FakeContainerDriver();
  const agents = new FakeAgentRunner();
  const git = new FakeGitClient();
  const orchestrator = new FakeOrchestratorClient();
  const flushes: Date[] = [];

  const deps: Deps = {
    config,
    clock,
    newId: uuidv7,
    ledger,
    events,
    broker,
    proxy,
    containers,
    agents,
    git,
    orchestrator,
    secret: (name) => `secret-${name}`,
    // Advances the injected clock instead of waiting, so a five-second
    // teardown grace costs a test nothing.
    sleep: async (ms) => {
      clock.advance(ms);
    },
    flushEvents: async () => {
      flushes.push(clock.now());
    },
  };

  const app = buildApp(deps);
  await app.ready();

  return {
    app,
    deps,
    config,
    clock,
    ledger,
    events,
    broker,
    proxy,
    containers,
    agents,
    git,
    orchestrator,
    stateDir,
    flushes,

    dispatch(options = {}) {
      return app.inject({
        method: 'POST',
        url: '/plans',
        remoteAddress: options.remoteAddress ?? ORCHESTRATOR_PEER,
        payload: options.payload ?? planDispatch(),
      });
    },

    inject(options) {
      return app.inject({ remoteAddress: ORCHESTRATOR_PEER, ...options });
    },

    provisionEnvironment(planId, environmentOverrides = {}) {
      const agent = new FakeAgentHandle(planId);
      const root = path.join(stateDir, 'plans', planId);
      ledger.add({
        planId,
        state: 'running',
        root,
        workdir: path.join(root, 'repo'),
        agent,
        network: `mycelium-${planId}`,
        proxyUrl: 'http://10.99.0.1:3128',
        brokerSocket: path.join(root, 'run', 'broker.sock'),
        egress: environmentOverrides.egress ?? [...config.standingEgress, 'api.github.com'],
        ttlExpiresAt: new Date(clock.now().getTime() + 240 * 60_000),
        sandboxes: new Set(),
      });
      return agent;
    },

    reset() {
      for (const environment of ledger.list()) ledger.remove(environment.planId);
      events.reset();
      broker.reset();
      proxy.reset();
      containers.reset();
      agents.reset();
      git.reset();
      orchestrator.reset();
      flushes.length = 0;
      clock.set(new Date('2026-09-02T12:00:00.000Z'));
    },

    async close() {
      await app.close();
      await rm(stateDir, { recursive: true, force: true });
    },
  };
}
