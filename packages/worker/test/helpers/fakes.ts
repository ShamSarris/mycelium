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
import type { ToolCall, ToolOutcome, ToolRegistry } from '../../src/tools/registry.js';
import {
  UsageUnavailable,
  type ModelRequest,
  type ModelResponse,
  type ModelTransport,
  type NormalizedUsage,
  type ToolDeclaration,
} from '../../src/transport/transport.js';

/**
 * The four seams, faked. Every test in this package runs against these: no
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

/**
 * A scripted transport. Constructed with the turns it should return, in order;
 * every loop, budget, tool, and shutdown test drives one of these. A turn that
 * is an `Error` is thrown instead of returned, which is how transport failure
 * and usage-unavailable are tested.
 */
export class FakeTransport implements ModelTransport {
  readonly requests: ModelRequest[] = [];
  readonly aborted: boolean[] = [];
  private readonly turns: Array<ModelResponse | Error>;
  private index = 0;
  /** Resolved when a call starts, so a test can signal abort mid-flight. */
  onSend: ((request: ModelRequest) => void | Promise<void>) | null = null;

  constructor(turns: Array<ModelResponse | Error> = []) {
    this.turns = [...turns];
  }

  push(turn: ModelResponse | Error): void {
    this.turns.push(turn);
  }

  get callCount(): number {
    return this.requests.length;
  }

  async send(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    this.requests.push(structuredClone(request));
    await this.onSend?.(request);

    if (signal.aborted) {
      this.aborted.push(true);
      throw abortError();
    }

    const turn = this.turns[this.index];
    this.index += 1;
    if (turn === undefined) {
      throw new Error(`FakeTransport ran out of turns after ${this.index} calls`);
    }
    if (turn instanceof Error) throw turn;
    return turn;
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
 * loop or a transport behind it. Modelled on `FakeTransport`.
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

    // Honours the abort signal the same way `FakeTransport` does: a caller
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

export function usage(overrides: Partial<NormalizedUsage> = {}): NormalizedUsage {
  return {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    source: 'provider',
    ...overrides,
  };
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

export { BrokerRejection, StatusRejected, UsageUnavailable };

/**
 * A registry the loop tests drive directly. It declares two stand-in tools
 * alongside the terminating pair, so the threading assertions have something
 * to thread without pulling the real tool implementations into WP5.
 */
export class FakeRegistry implements ToolRegistry {
  readonly calls: ToolCall[] = [];
  /** Keyed by tool name. Anything unlisted comes back as an empty result. */
  readonly results = new Map<string, ToolOutcome>();
  completeWith: { summary: string; commitSha?: string; notes?: string } = {
    summary: 'did the thing',
  };
  failWith: { errorClass: string; detail: string } = {
    errorClass: 'task_failed',
    detail: 'could not do the thing',
  };
  /** Set to make a named tool throw, which the loop must answer anyway. */
  throwFor: string | null = null;

  declarations(): ToolDeclaration[] {
    return [
      declare('sandbox', { cmd: { type: 'array', items: { type: 'string' } } }),
      declare('read_file', { path: { type: 'string' } }),
      declare('task_complete', { summary: { type: 'string' } }),
      declare('task_failed', { error_class: { type: 'string' }, detail: { type: 'string' } }),
    ];
  }

  async invoke(call: ToolCall): Promise<ToolOutcome> {
    this.calls.push(call);
    if (this.throwFor === call.name) throw new Error(`${call.name} exploded`);
    if (call.name === 'task_complete') return { kind: 'complete', ...this.completeWith };
    if (call.name === 'task_failed') return { kind: 'failed', ...this.failWith };
    return this.results.get(call.name) ?? { kind: 'result', content: '', isError: false };
  }
}

function declare(name: string, properties: Record<string, unknown>): ToolDeclaration {
  return {
    name,
    description: `the ${name} tool`,
    inputSchema: { type: 'object', additionalProperties: false, properties },
  };
}
