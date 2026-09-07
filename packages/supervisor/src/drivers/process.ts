/**
 * The plan agent as the supervisor sees it: something to start, hand tasks to,
 * signal, and wait for. Ticket 0003 does not build the agent itself (that is
 * baseline step 4) — only the seam it will be started through.
 */

export interface AgentSpec {
  planId: string;
  /** The repo checkout. The agent's working directory and the sandbox mount. */
  cwd: string;
  /** Includes the three per-plan credentials. Deliberate injection, not inheritance. */
  env: Record<string, string>;
  /** Where the supervisor listens for the agent's sandbox and event calls. */
  brokerSocket: string;
  /** Where the agent listens for task dispatch. */
  dispatchSocket: string;
}

export type DispatchOutcome =
  | { accepted: true }
  | { accepted: false; reason: string; unreachable: boolean };

export interface AgentHandle {
  readonly planId: string;
  /**
   * Delivers one task dispatch. Anything but `accepted` becomes a 409, which
   * the orchestrator turns into an immediate return to `ready` rather than
   * waiting out the lease.
   *
   * The refusal carries the agent's own reason. That reason is the whole
   * diagnosis of a plan that would otherwise redispatch every two seconds
   * until its TTL, and it used to be discarded before any caller saw it.
   * `unreachable` separates "the agent answered, and said no" from "nothing
   * answered" — only the second is evidence the agent is gone.
   */
  dispatch(task: unknown): Promise<DispatchOutcome>;
  /** Signals the whole process group, so a shell child cannot outlive its parent. */
  signal(signal: 'SIGTERM' | 'SIGKILL'): Promise<void>;
  hasExited(): boolean;
}

export interface AgentRunner {
  start(spec: AgentSpec): Promise<AgentHandle>;
  /**
   * Asks whatever is on `dispatchSocket` whether it is still this plan's
   * agent, and returns a handle to it if so. This is how a restarted
   * supervisor re-attaches (ticket 0004 section 11): the agent reports task
   * status straight to the orchestrator, so nothing about the task in flight
   * needs recovering — only the ability to hand it the next one.
   *
   * Null for anything else: no socket, a timeout, a wrong plan id, a malformed
   * answer. Adopting on a maybe would produce a plan that looks alive and
   * answers nothing, which is worse than killing it.
   */
  probe(planId: string, dispatchSocket: string): Promise<AgentHandle | null>;
  /** Plan ids with a live agent process, for restart reconciliation. */
  listRunning(): Promise<string[]>;
  /**
   * Kills a plan's process group without holding a handle to it. Restart
   * reconciliation finds processes this instance never started, so it has no
   * handle and needs a way to end them anyway.
   */
  kill(planId: string): Promise<void>;
}
