import type { EventEnvelope } from '@mycelium/contracts';
import type { Clock } from '../../src/clock.js';
import type {
  Assignments,
  OrchestratorClient,
  PostEventsResult,
} from '../../src/clients/orchestrator.js';
import type {
  ContainerDriver,
  RunningContainer,
  SandboxResult,
  SandboxSpec,
} from '../../src/drivers/container.js';
import { CloneError, type CloneSpec, type GitClient } from '../../src/drivers/git.js';
import type { AgentHandle, AgentRunner, AgentSpec } from '../../src/drivers/process.js';
import type { EmittedEvent, EventSink } from '../../src/events/sink.js';
import type { Broker } from '../../src/rpc/broker.js';
import type { ProxyListener } from '../../src/proxy/connect.js';

/**
 * Tests override a fake's method to force a failure (`driver.kill = throws`).
 * That assignment lands as an own property and would shadow the prototype for
 * every later test in the file, so every reset() drops own function properties
 * and lets the real implementations show through again.
 */
function restoreMethods(target: object): void {
  for (const key of Object.getOwnPropertyNames(target)) {
    if (typeof (target as Record<string, unknown>)[key] === 'function') {
      delete (target as Record<string, unknown>)[key];
    }
  }
}

/** Lets a test advance time rather than sleep through a TTL or a teardown grace. */
export class MutableClock implements Clock {
  private current = new Date('2026-09-02T12:00:00.000Z');

  now(): Date {
    return new Date(this.current);
  }

  set(at: Date): void {
    this.current = new Date(at);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export class FakeGitClient implements GitClient {
  readonly clones: CloneSpec[] = [];
  failWith: CloneError | null = null;

  async clone(spec: CloneSpec): Promise<void> {
    this.clones.push(spec);
    if (this.failWith !== null) throw this.failWith;
  }

  reset(): void {
    restoreMethods(this);
    this.clones.length = 0;
    this.failWith = null;
  }
}

export class FakeAgentHandle implements AgentHandle {
  readonly dispatches: unknown[] = [];
  readonly signals: string[] = [];
  accepting = true;
  /** An agent that ignores SIGTERM, so the SIGKILL path can be tested. */
  ignoresSigterm = false;
  private exited = false;

  constructor(readonly planId: string) {}

  async dispatch(task: unknown): Promise<boolean> {
    this.dispatches.push(task);
    return this.accepting;
  }

  async signal(signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
    this.signals.push(signal);
    if (signal === 'SIGKILL' || !this.ignoresSigterm) this.exited = true;
  }

  hasExited(): boolean {
    return this.exited;
  }
}

export class FakeAgentRunner implements AgentRunner {
  readonly started: AgentSpec[] = [];
  readonly handles = new Map<string, FakeAgentHandle>();
  failNext: Error | null = null;
  readonly killed: string[] = [];
  /** Plan ids a restart scan should find running on the VM. */
  orphans: string[] = [];

  async start(spec: AgentSpec): Promise<AgentHandle> {
    if (this.failNext !== null) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
    this.started.push(spec);
    const handle = new FakeAgentHandle(spec.planId);
    this.handles.set(spec.planId, handle);
    return handle;
  }

  /** Plan ids whose agent will answer `agent.ping`. Everything else probes null. */
  answering = new Set<string>();
  readonly probed: Array<{ planId: string; socket: string }> = [];

  async probe(planId: string, dispatchSocket: string): Promise<AgentHandle | null> {
    this.probed.push({ planId, socket: dispatchSocket });
    if (!this.answering.has(planId)) return null;
    const handle = this.handles.get(planId) ?? new FakeAgentHandle(planId);
    this.handles.set(planId, handle);
    return handle;
  }

  async listRunning(): Promise<string[]> {
    return [...new Set([...this.handles.keys(), ...this.orphans])];
  }

  async kill(planId: string): Promise<void> {
    this.killed.push(planId);
    this.orphans = this.orphans.filter((id) => id !== planId);
    this.handles.delete(planId);
  }

  reset(): void {
    restoreMethods(this);
    this.started.length = 0;
    this.handles.clear();
    this.killed.length = 0;
    this.failNext = null;
    this.orphans = [];
    this.answering.clear();
    this.probed.length = 0;
  }
}

export class FakeContainerDriver implements ContainerDriver {
  readonly networks = new Map<string, string>();
  readonly removedNetworks: string[] = [];
  readonly runs: SandboxSpec[] = [];
  readonly killed: string[] = [];
  /** Containers a restart scan should find, keyed by container id. */
  existing: RunningContainer[] = [];
  nextResult: Partial<SandboxResult> = {};
  failNetwork: Error | null = null;
  /** Held open so a test can assert teardown kills a sandbox that is still running. */
  private release: (() => void) | null = null;
  private counter = 0;

  async createNetwork(planId: string): Promise<{ name: string; gatewayAddress: string }> {
    if (this.failNetwork !== null) throw this.failNetwork;
    const name = `mycelium-${planId}`;
    this.networks.set(planId, name);
    return { name, gatewayAddress: '10.99.0.1' };
  }

  async removeNetwork(name: string): Promise<void> {
    this.removedNetworks.push(name);
  }

  async run(spec: SandboxSpec, onStarted: (id: string) => void): Promise<SandboxResult> {
    this.runs.push(spec);
    this.counter += 1;
    const containerId = `container-${this.counter}`;
    onStarted(containerId);

    if (this.release !== null) {
      await new Promise<void>((resolve) => {
        const previous = this.release;
        this.release = () => {
          previous?.();
          resolve();
        };
      });
    }

    return {
      containerId,
      // `null` is a real exit code here — a container the wall clock killed
      // never reported one — so it must not collapse into 0.
      exitCode: this.nextResult.exitCode === undefined ? 0 : this.nextResult.exitCode,
      timedOut: this.nextResult.timedOut ?? false,
      stdout: this.nextResult.stdout ?? Buffer.from(''),
      stderr: this.nextResult.stderr ?? Buffer.from(''),
    };
  }

  async kill(containerId: string): Promise<void> {
    this.killed.push(containerId);
  }

  async listContainers(): Promise<RunningContainer[]> {
    return this.existing;
  }

  /** Makes the next run() hang until releaseRuns() is called. */
  holdRuns(): void {
    this.release = () => {};
  }

  releaseRuns(): void {
    this.release?.();
    this.release = null;
  }

  reset(): void {
    restoreMethods(this);
    this.networks.clear();
    this.removedNetworks.length = 0;
    this.runs.length = 0;
    this.killed.length = 0;
    this.existing = [];
    this.nextResult = {};
    this.failNetwork = null;
    this.release = null;
    this.counter = 0;
  }
}

export class FakeOrchestratorClient implements OrchestratorClient {
  readonly heartbeats: Date[] = [];
  readonly batches: EventEnvelope[][] = [];
  assignmentsResponse: Assignments = { plans: [], high_water_marks: [] };
  assignmentsThrows = false;
  nextPostResults: PostEventsResult[] = [];

  async heartbeat(): Promise<void> {
    this.heartbeats.push(new Date());
  }

  async assignments(): Promise<Assignments> {
    if (this.assignmentsThrows) throw new Error('orchestrator unreachable');
    return this.assignmentsResponse;
  }

  async postEvents(events: EventEnvelope[]): Promise<PostEventsResult> {
    this.batches.push(events);
    return (
      this.nextPostResults.shift() ?? { ok: true, inserted: events.length, duplicates: 0 }
    );
  }

  /** Every envelope this client has been handed, flattened. */
  get delivered(): EventEnvelope[] {
    return this.batches.flat();
  }

  reset(): void {
    restoreMethods(this);
    this.heartbeats.length = 0;
    this.batches.length = 0;
    this.assignmentsResponse = { plans: [], high_water_marks: [] };
    this.assignmentsThrows = false;
    this.nextPostResults = [];
  }
}

/** Records what was emitted without touching the disk spool. */
export class RecordingEventSink implements EventSink {
  readonly events: EmittedEvent[] = [];

  async emit(event: EmittedEvent): Promise<void> {
    this.events.push(event);
  }

  ofType(type: string): EmittedEvent[] {
    return this.events.filter((event) => event.type === type);
  }

  reset(): void {
    restoreMethods(this);
    this.events.length = 0;
  }
}

/** Records which sockets were opened without binding anything. */
export class FakeBroker implements Broker {
  readonly listening = new Map<string, string>();
  readonly closed: string[] = [];
  failNext: Error | null = null;

  async listen(planId: string, socketPath: string): Promise<void> {
    if (this.failNext !== null) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
    this.listening.set(planId, socketPath);
  }

  async close(planId: string): Promise<void> {
    this.listening.delete(planId);
    this.closed.push(planId);
  }

  async closeAll(): Promise<void> {
    for (const planId of [...this.listening.keys()]) await this.close(planId);
  }

  reset(): void {
    restoreMethods(this);
    this.listening.clear();
    this.closed.length = 0;
    this.failNext = null;
  }
}

/** Records which plans got a listener without binding a port. */
export class FakeProxy implements ProxyListener {
  readonly listening = new Map<string, string>();
  readonly closed: string[] = [];

  async listen(planId: string, host: string): Promise<{ url: string; port: number }> {
    const url = `http://${host}:3128`;
    this.listening.set(planId, url);
    return { url, port: 3128 };
  }

  async close(planId: string): Promise<void> {
    this.listening.delete(planId);
    this.closed.push(planId);
  }

  async closeAll(): Promise<void> {
    for (const planId of [...this.listening.keys()]) await this.close(planId);
  }

  reset(): void {
    restoreMethods(this);
    this.listening.clear();
    this.closed.length = 0;
  }
}
