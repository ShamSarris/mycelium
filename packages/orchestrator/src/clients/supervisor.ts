/**
 * What the orchestrator calls on a node supervisor, over plain HTTP/JSON across
 * the tailnet (decision B8). Ticket 0003 implements the server side to match.
 *
 * NOTE: no credential is presented. Baseline section 7 stores only the hash of
 * each supervisor's bearer token, so the orchestrator cannot replay it, and no
 * sixth long-lived secret exists yet for the reverse direction. Until that is
 * decided the supervisor must authorise the caller by tailnet peer identity.
 */

export interface AgentTarget {
  id: string;
  name: string;
  base_url: string;
}

export type TeardownReason = 'completion' | 'ttl_expired' | 'cancelled' | 'failed';

export interface PlanDispatch {
  plan_id: string;
  project: { id: string; name: string };
  gitea: { repo_url: string; branch: string; bot_token: string };
  /** The per-plan orchestrator API token, plaintext. The only time it leaves this process. */
  orchestrator_token: string;
  egress: string[];
  max_concurrent_agents: number;
  env_ttl_min: number;
}

export interface TaskDispatch {
  plan_id: string;
  task_id: string;
  local_id: string;
  dispatch_id: string;
  execution_attempt: number;
  description: string;
  limits: { cost_microusd: number; wall_clock_min: number };
  /** Detail figure; cost_spent_microusd is authoritative (D30). */
  tokens_spent_so_far: number;
}

export type PlanDispatchResult =
  | { accepted: true }
  | { accepted: false; code: 'capacity_exceeded' | 'validation_failed'; retryable: boolean };

export interface SupervisorClient {
  dispatchPlan(agent: AgentTarget, req: PlanDispatch): Promise<PlanDispatchResult>;
  dispatchTask(agent: AgentTarget, req: TaskDispatch): Promise<{ accepted: boolean }>;
  authorizeTeardown(agent: AgentTarget, planId: string, reason: TeardownReason): Promise<void>;
}

export class HttpSupervisorClient implements SupervisorClient {
  constructor(private readonly timeoutMs = 10_000) {}

  private async post(agent: AgentTarget, path: string, body: unknown): Promise<Response> {
    return fetch(`${agent.base_url.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  /**
   * An unreachable VM is treated exactly like a full one: not accepted, and
   * retryable. The dispatcher then tries the next candidate, which is the
   * behaviour that turns first-fit into failover (B12).
   */
  async dispatchPlan(agent: AgentTarget, req: PlanDispatch): Promise<PlanDispatchResult> {
    let response: Response;
    try {
      response = await this.post(agent, '/plans', req);
    } catch {
      return { accepted: false, code: 'capacity_exceeded', retryable: true };
    }

    if (response.ok) return { accepted: true };

    let code: 'capacity_exceeded' | 'validation_failed' = 'capacity_exceeded';
    try {
      const body = (await response.json()) as { code?: string };
      if (body.code === 'validation_failed') code = 'validation_failed';
    } catch {
      // A supervisor that cannot explain itself is treated as full.
    }

    return { accepted: false, code, retryable: code !== 'validation_failed' };
  }

  async dispatchTask(agent: AgentTarget, req: TaskDispatch): Promise<{ accepted: boolean }> {
    const response = await this.post(agent, `/plans/${req.plan_id}/tasks`, req);
    return { accepted: response.ok };
  }

  async authorizeTeardown(
    agent: AgentTarget,
    planId: string,
    reason: TeardownReason,
  ): Promise<void> {
    await this.post(agent, `/plans/${planId}/teardown`, { reason });
  }
}
