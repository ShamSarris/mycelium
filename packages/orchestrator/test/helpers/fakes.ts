import type { Clock } from '../../src/clock.js';
import type { GiteaClient } from '../../src/clients/gitea.js';
import type {
  AgentTarget,
  PlanDispatch,
  PlanDispatchResult,
  SupervisorClient,
  TaskDispatch,
  TeardownReason,
} from '../../src/clients/supervisor.js';

export class MutableClock implements Clock {
  constructor(private current: Date = new Date('2026-09-02T12:00:00.000Z')) {}

  now(): Date {
    return new Date(this.current);
  }

  set(when: Date): void {
    this.current = when;
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  advanceMinutes(minutes: number): void {
    this.advance(minutes * 60_000);
  }
}

export class FakeGiteaClient implements GiteaClient {
  readonly ensureRepoCalls: string[] = [];
  readonly createBranchCalls: Array<{ repo: string; branch: string }> = [];
  readonly createBotTokenCalls: Array<{ repo: string; planId: string }> = [];
  readonly revokeCalls: string[] = [];
  readonly fileExistsCalls: Array<{ repo: string; branch: string; path: string }> = [];
  readonly openPullRequestCalls: Array<{ repo: string; head: string }> = [];

  fileExistsResult = true;
  headShaValue = 'a1b2c3d4e5f6';
  pullRequestUrl: string | null = 'http://gitea.local/mycelium/demo/pulls/1';

  /** Method names that should throw once, then succeed. */
  readonly throwOnce = new Set<string>();
  /** Method names that should throw on every call. */
  readonly throwAlways = new Set<string>();

  private maybeThrow(method: string): void {
    if (this.throwAlways.has(method)) {
      throw new Error(`fake gitea failure in ${method}`);
    }
    if (this.throwOnce.has(method)) {
      this.throwOnce.delete(method);
      throw new Error(`fake gitea failure in ${method}`);
    }
  }

  async ensureRepo(name: string): Promise<{ clone_url: string }> {
    this.maybeThrow('ensureRepo');
    this.ensureRepoCalls.push(name);
    return { clone_url: `http://gitea.local/mycelium/${name}.git` };
  }

  async createBranch(repo: string, branch: string): Promise<void> {
    this.maybeThrow('createBranch');
    this.createBranchCalls.push({ repo, branch });
  }

  async createBotToken(repo: string, planId: string): Promise<{ token: string; ref: string }> {
    this.maybeThrow('createBotToken');
    this.createBotTokenCalls.push({ repo, planId });
    const suffix = this.createBotTokenCalls.length;
    return { token: `bot-token-${planId}-${suffix}`, ref: `bot-user-${planId}-${suffix}` };
  }

  async revokeBotToken(ref: string): Promise<void> {
    this.maybeThrow('revokeBotToken');
    this.revokeCalls.push(ref);
  }

  async fileExists(repo: string, branch: string, path: string): Promise<boolean> {
    this.maybeThrow('fileExists');
    this.fileExistsCalls.push({ repo, branch, path });
    return this.fileExistsResult;
  }

  async headSha(): Promise<string> {
    this.maybeThrow('headSha');
    return this.headShaValue;
  }

  async openPullRequest(repo: string, head: string): Promise<{ url: string } | null> {
    this.maybeThrow('openPullRequest');
    this.openPullRequestCalls.push({ repo, head });
    return this.pullRequestUrl === null ? null : { url: this.pullRequestUrl };
  }
}

export class FakeSupervisorClient implements SupervisorClient {
  readonly planDispatches: Array<{ agentId: string; request: PlanDispatch }> = [];
  readonly taskDispatches: Array<{ agentId: string; request: TaskDispatch }> = [];
  readonly teardowns: Array<{ agentId: string; planId: string; reason: TeardownReason }> = [];

  /** Per-agent scripted answers; anything unscripted uses defaultPlanResponse. */
  readonly planResponses = new Map<string, PlanDispatchResult>();
  defaultPlanResponse: PlanDispatchResult = { accepted: true };

  taskAccepted = true;
  /** What a refusing supervisor says, as the 409 body's message. */
  taskRejectionReason: string | undefined = undefined;
  taskThrows = false;
  teardownThrows = false;

  async dispatchPlan(agent: AgentTarget, request: PlanDispatch): Promise<PlanDispatchResult> {
    this.planDispatches.push({ agentId: agent.id, request });
    return this.planResponses.get(agent.id) ?? this.defaultPlanResponse;
  }

  async dispatchTask(
    agent: AgentTarget,
    request: TaskDispatch,
  ): Promise<{ accepted: boolean; reason?: string }> {
    if (this.taskThrows) throw new Error('fake supervisor is unreachable');
    this.taskDispatches.push({ agentId: agent.id, request });
    if (this.taskAccepted) return { accepted: true };
    return this.taskRejectionReason === undefined
      ? { accepted: false }
      : { accepted: false, reason: this.taskRejectionReason };
  }

  async authorizeTeardown(
    agent: AgentTarget,
    planId: string,
    reason: TeardownReason,
  ): Promise<void> {
    if (this.teardownThrows) throw new Error('fake supervisor is unreachable');
    this.teardowns.push({ agentId: agent.id, planId, reason });
  }
}
