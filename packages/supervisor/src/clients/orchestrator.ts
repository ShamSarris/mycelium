import type { EventEnvelope } from '@mycelium/contracts';

/**
 * The three calls the supervisor makes upward, all authenticated with its
 * per-VM bearer token, whose hash is the only copy the orchestrator holds.
 */

export interface Assignments {
  plans: Array<{ plan_id: string; state: string; project_id: string }>;
  /** Highest seq the orchestrator has stored per stream, for seq recovery. */
  high_water_marks: Array<{ stream_id: string; seq: number }>;
}

/**
 * A batch either lands or does not. `retryable` separates an orchestrator that
 * is down — keep the spool and try again — from one that refused the batch,
 * which is an emitter bug no amount of retrying fixes.
 */
export type PostEventsResult =
  | { ok: true; inserted: number; duplicates: number }
  | { ok: false; retryable: boolean; status: number | null; message: string };

export interface OrchestratorClient {
  heartbeat(): Promise<void>;
  assignments(): Promise<Assignments>;
  postEvents(events: EventEnvelope[]): Promise<PostEventsResult>;
}

export class HttpOrchestratorClient implements OrchestratorClient {
  constructor(
    private readonly baseUrl: string,
    private readonly supervisorId: string,
    private readonly token: string,
    private readonly timeoutMs = 10_000,
  ) {}

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', authorization: `Bearer ${this.token}` };
  }

  async heartbeat(): Promise<void> {
    const response = await fetch(`${this.baseUrl}/supervisors/${this.supervisorId}/heartbeat`, {
      method: 'POST',
      headers: this.headers(),
      body: '{}',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`heartbeat rejected with ${response.status}`);
    }
  }

  async assignments(): Promise<Assignments> {
    const response = await fetch(`${this.baseUrl}/supervisors/${this.supervisorId}/assignments`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`assignments rejected with ${response.status}`);
    }
    return (await response.json()) as Assignments;
  }

  async postEvents(events: EventEnvelope[]): Promise<PostEventsResult> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/events`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(events),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      return { ok: false, retryable: true, status: null, message: (error as Error).message };
    }

    if (response.ok) {
      const body = (await response.json()) as { inserted: number; duplicates: number };
      return { ok: true, inserted: body.inserted, duplicates: body.duplicates };
    }

    // 4xx means the orchestrator understood the batch and refused it. Retrying
    // would spin forever on the same bad record, so the caller sets it aside.
    return {
      ok: false,
      retryable: response.status >= 500 || response.status === 429,
      status: response.status,
      message: await response.text().catch(() => ''),
    };
  }
}
