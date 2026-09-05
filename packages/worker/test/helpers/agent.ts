import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, type WorkerConfig } from '../../src/config.js';
import type { Deps } from '../../src/deps.js';
import type { TaskDispatch } from '../../src/protocol.js';
import {
  FakeBroker,
  FakeGitClient,
  FakeOrchestratorClient,
  FakeTransport,
  MutableClock,
} from './fakes.js';

export const PLAN_ID = '018f3a5c-0000-7000-8000-00000000000a';
export const PROJECT_ID = '018f3a5c-0000-7000-8000-0000000000b0';
export const BRANCH = `plan/${PLAN_ID}`;

export interface TestWorker {
  deps: Deps;
  config: WorkerConfig;
  clock: MutableClock;
  transport: FakeTransport;
  broker: FakeBroker;
  orchestrator: FakeOrchestratorClient;
  git: FakeGitClient;
  /** A real temporary directory standing in for the plan's checkout. */
  workdir: string;
  runDir: string;
  /** Advances the injected clock instead of waiting; every sleep is recorded. */
  sleeps: number[];
  close(): Promise<void>;
}

/**
 * One agent's worth of dependencies, all faked, with a real temporary workdir
 * because the file tools' containment rules are only worth testing against a
 * real filesystem.
 */
export async function buildTestWorker(
  overrides: Partial<Record<string, string>> = {},
): Promise<TestWorker> {
  const root = await mkdtemp(path.join(tmpdir(), 'mycelium-worker-'));
  const workdir = path.join(root, 'repo');
  const runDir = path.join(root, 'run');
  await mkdir(workdir, { recursive: true });
  await mkdir(runDir, { recursive: true });

  const clock = new MutableClock();
  const sleeps: number[] = [];

  const config = loadConfig({
    PLAN_ID,
    PROJECT_ID,
    PROJECT_NAME: 'demo',
    ORCHESTRATOR_URL: 'http://orchestrator.tailnet:8080',
    ORCHESTRATOR_TOKEN: 'plan-token',
    GITEA_BOT_TOKEN: 'gitea-bot-token',
    GITEA_BRANCH: BRANCH,
    MODEL_API_KEY: 'sk-ant-test',
    AGENT_SOCKET: path.join(runDir, 'broker.sock'),
    DISPATCH_SOCKET: path.join(runDir, 'dispatch.sock'),
    WORKDIR: workdir,
    ...overrides,
  } as NodeJS.ProcessEnv);

  const transport = new FakeTransport();
  const broker = new FakeBroker();
  const orchestrator = new FakeOrchestratorClient(clock);
  const git = new FakeGitClient(BRANCH);

  const deps: Deps = {
    config,
    clock,
    broker,
    orchestrator,
    transport,
    git,
    // Time passes on the injected clock, never in real seconds, so a retry
    // window or a wall-clock limit costs a test nothing to reach.
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock.advance(ms);
    },
  };

  return {
    deps,
    config,
    clock,
    transport,
    broker,
    orchestrator,
    git,
    workdir,
    runDir,
    sleeps,
    close: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** A task dispatch with everything the orchestrator actually sends. */
export function taskDispatch(overrides: Partial<TaskDispatch> = {}): TaskDispatch {
  return {
    plan_id: PLAN_ID,
    task_id: '018f3a5c-0000-7000-8000-0000000000c1',
    local_id: 't1',
    dispatch_id: '018f3a5c-0000-7000-8000-0000000000d1',
    execution_attempt: 1,
    description: 'Add a health endpoint and a test for it.',
    limits: { tokens: 100_000, wall_clock_min: 30 },
    tokens_spent_so_far: 0,
    ...overrides,
  };
}
