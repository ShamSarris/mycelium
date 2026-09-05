/**
 * The orchestrator as this agent sees it: one route, `POST
 * /plans/:id/tasks/:taskId/status`, authorised by the per-plan token.
 *
 * Deliberately not routed through the supervisor. That is what lets a
 * supervisor restart re-attach to a live agent without recovering any
 * in-flight task state — the agent never noticed it was gone (ticket 0004
 * section 11).
 */
export interface OrchestratorClient {
  /** `timeoutMs` overrides the client's own deadline; shutdown passes a short one. */
  reportStatus(taskId: string, report: StatusReport, timeoutMs?: number): Promise<void>;
}

/** The orchestrator's `StatusReport`, matched field for field. */
export interface StatusReport {
  state: 'running' | 'done' | 'failed';
  tokens_spent?: number;
  result?: unknown;
  error?: string;
}

/** A 4xx: the report itself is wrong, so retrying it is pointless. */
export class StatusRejected extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'StatusRejected';
  }
}

/**
 * The real client. One route, one token, no retry — the policy around it lives
 * in `reporting.ts`, so the transport can stay a thin thing that says plainly
 * whether the orchestrator refused the report or merely failed to answer.
 */
export class HttpOrchestratorClient implements OrchestratorClient {
  constructor(
    private readonly baseUrl: string,
    private readonly planId: string,
    private readonly token: string,
    private readonly timeoutMs = 10_000,
  ) {}

  async reportStatus(taskId: string, report: StatusReport, timeoutMs?: number): Promise<void> {
    const response = await fetch(
      `${this.baseUrl}/plans/${this.planId}/tasks/${taskId}/status`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(report),
        signal: AbortSignal.timeout(timeoutMs ?? this.timeoutMs),
      },
    );

    if (response.ok) return;

    // The distinction is the whole point of this class: a 4xx is a wrong body
    // and retrying it re-sends the same wrong body, while a 5xx or a timeout is
    // the orchestrator having a bad moment.
    if (response.status >= 400 && response.status < 500) {
      throw new StatusRejected(response.status, await describe(response));
    }

    throw new Error(`the orchestrator answered ${response.status}`);
  }
}

async function describe(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    const error = body.error;
    if (error?.code !== undefined) return `${error.code}: ${error.message ?? ''}`.trim();
  } catch {
    // A refusal with an unreadable body is still a refusal.
  }
  return `the orchestrator refused the report with ${response.status}`;
}
