import type { Clock } from '../../src/clock.js';
import {
  BrokerRejection,
  type AgentEvent,
  type BrokerClient,
  type SandboxResult,
  type SandboxRunParams,
} from '../../src/broker.js';
import {
  StatusRejected,
  type OrchestratorClient,
  type StatusReport,
} from '../../src/orchestrator.js';
import type { TaskDispatch } from '../../src/protocol.js';
import type { TaskOutcome, TaskRunner } from '../../src/runner/runner.js';
import { BranchNotAllowed, type GitClient, type GitStatus } from '../../src/tools/git.js';

/**
 * The seams, faked. Every test in this package runs against these: no
 * network, no model, no git binary, no real supervisor. The bargain ticket
 * 0003 made with its driver fakes, made again — the parts that cannot be
 * faked are the opt-in live suite in WP11.
 */

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

function abortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * A scripted `TaskRunner`. Constructed with the outcomes it should return, in
 * order; `test/runner.test.ts` drives one of these to prove `task.ts` calls
 * `deps.runner.run` with the dispatch and the signal, without needing a real
 * runner behind it. `buildTestWorker` (`test/helpers/agent.ts`) wires one of
 * these into `deps.runner` by default — most suites never invoke it directly
 * and only need something satisfying `TaskRunner`.
 */
export class FakeTaskRunner implements TaskRunner {
  readonly calls: Array<{ dispatch: TaskDispatch; signal: AbortSignal }> = [];
  private readonly outcomes: TaskOutcome[];
  private index = 0;

  constructor(outcomes: TaskOutcome[] = []) {
    this.outcomes = [...outcomes];
  }

  push(outcome: TaskOutcome): void {
    this.outcomes.push(outcome);
  }

  get callCount(): number {
    return this.calls.length;
  }

  async run(dispatch: TaskDispatch, signal: AbortSignal): Promise<TaskOutcome> {
    this.calls.push({ dispatch: structuredClone(dispatch), signal });

    // Honours the abort signal the way a real `TaskRunner` must: a caller
    // that aborted before the runner produced anything gets an abort, not a
    // scripted outcome it never asked for.
    if (signal.aborted) throw abortError();

    const outcome = this.outcomes[this.index];
    this.index += 1;
    if (outcome === undefined) {
      throw new Error(`FakeTaskRunner ran out of outcomes after ${this.index} calls`);
    }
    return outcome;
  }
}

/**
 * A `TaskRunner` double for `test/shutdown.test.ts`: it never resolves on its
 * own. It honours the abort signal the way a well-behaved `TaskRunner` must
 * (`runner/agent-sdk.ts`'s own "abort" handling is the model this follows) —
 * emitting the same `error{stage:'aborted'}` event before resolving, and
 * reporting a failed outcome naming the abort reason. `shutdown.test.ts`
 * needs a task genuinely "in flight" when it triggers shutdown; this is a
 * generic stand-in for whichever real `TaskRunner` is wired at the time; it
 * proves `shutdown()`'s own behaviour rather than re-testing a specific
 * runner's internals (that belongs to `test/runner/agent-sdk.test.ts`).
 */
export class BlockingTaskRunner implements TaskRunner {
  private notifyStarted: (() => void) | null = null;
  /** Resolves once `run` has actually been called, so a test can wait until the task is in flight. */
  readonly started: Promise<void> = new Promise((resolve) => {
    this.notifyStarted = resolve;
  });

  constructor(private readonly broker: BrokerClient) {}

  async run(dispatch: TaskDispatch, signal: AbortSignal): Promise<TaskOutcome> {
    this.notifyStarted?.();

    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener('abort', () => resolve(), { once: true });
    });

    const reason =
      typeof signal.reason === 'string' && signal.reason !== ''
        ? signal.reason
        : 'the environment is being torn down';

    await this.broker.emit({
      type: 'error',
      severity: 'warn',
      taskId: dispatch.task_id,
      payload: { stage: 'aborted', reason },
    });

    return { state: 'failed', error: `aborted: ${reason}`, costMicrousd: 0, tokensSpent: 0 };
  }
}

export class FakeBroker implements BrokerClient {
  readonly events: AgentEvent[] = [];
  readonly sandboxCalls: SandboxRunParams[] = [];
  /** Set to make `emit` throw, which the agent must survive. */
  emitFailsWith: Error | null = null;
  /** Set to make `sandbox.run` return a structured refusal. */
  sandboxRejectsWith: BrokerRejection | null = null;
  sandboxResult: SandboxResult = sandboxResult();

  async emit(event: AgentEvent): Promise<void> {
    if (this.emitFailsWith !== null) throw this.emitFailsWith;
    this.events.push(structuredClone(event));
  }

  async sandboxRun(params: SandboxRunParams): Promise<SandboxResult> {
    this.sandboxCalls.push(structuredClone(params));
    if (this.sandboxRejectsWith !== null) throw this.sandboxRejectsWith;
    return this.sandboxResult;
  }

  ofType(type: AgentEvent['type']): AgentEvent[] {
    return this.events.filter((event) => event.type === type);
  }
}

export function sandboxResult(overrides: Partial<SandboxResult> = {}): SandboxResult {
  return {
    container_id: 'c-1',
    exit_code: 0,
    timed_out: false,
    stdout: { preview: '', bytes: 0, truncated: false },
    stderr: { preview: '', bytes: 0, truncated: false },
    ...overrides,
  };
}

export class FakeOrchestratorClient implements OrchestratorClient {
  readonly reports: Array<{ taskId: string; report: StatusReport; at: Date }> = [];
  /** The deadline each attempt was given, so shutdown's shorter one is visible. */
  readonly deadlines: Array<number | null> = [];
  /** Thrown on every call until cleared; `StatusRejected` is the non-retryable case. */
  failWith: Error | null = null;
  /** Fails this many calls, then succeeds. For the retry tests. */
  failFirst = 0;
  private readonly clock: Clock;

  constructor(clock: Clock) {
    this.clock = clock;
  }

  async reportStatus(taskId: string, report: StatusReport, timeoutMs?: number): Promise<void> {
    this.deadlines.push(timeoutMs ?? null);
    if (this.failFirst > 0) {
      this.failFirst -= 1;
      throw this.failWith ?? new Error('orchestrator unreachable');
    }
    if (this.failWith !== null) throw this.failWith;
    this.reports.push({ taskId, report: structuredClone(report), at: this.clock.now() });
  }

  get last(): StatusReport | undefined {
    return this.reports.at(-1)?.report;
  }
}

export function statusRejected(status = 400): StatusRejected {
  return new StatusRejected(status, `orchestrator rejected the report with ${status}`);
}

export class FakeGitClient implements GitClient {
  readonly commits: string[] = [];
  readonly pushes: string[] = [];
  /** The branch this fake will accept a push for. */
  allowedBranch: string;
  nothingToCommit = false;
  failWith: Error | null = null;
  private sha = 0;
  private currentHead = '0'.repeat(40);

  constructor(allowedBranch: string) {
    this.allowedBranch = allowedBranch;
  }

  async commit(message: string): Promise<string | null> {
    if (this.failWith !== null) throw this.failWith;
    if (this.nothingToCommit) return null;
    this.commits.push(message);
    this.sha += 1;
    this.currentHead = String(this.sha).padStart(40, 'a');
    return this.currentHead;
  }

  async push(branch: string): Promise<void> {
    if (branch !== this.allowedBranch) throw new BranchNotAllowed(branch, this.allowedBranch);
    if (this.failWith !== null) throw this.failWith;
    this.pushes.push(branch);
  }

  async status(): Promise<GitStatus> {
    return { branch: this.allowedBranch, clean: this.commits.length > 0, changed: [] };
  }

  async diff(): Promise<string> {
    return '';
  }

  async head(): Promise<string> {
    return this.currentHead;
  }
}

export { BrokerRejection, StatusRejected };
