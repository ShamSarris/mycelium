/**
 * The supervisor's error body is `{ code, message }` at the top level, not the
 * orchestrator's `{ error: { code, message } }`.
 *
 * This is deliberate and load-bearing: `HttpSupervisorClient.dispatchPlan`
 * reads `body.code` to tell a terminal `validation_failed` from a retryable
 * `capacity_exceeded`. Nesting it would make every terminal rejection look
 * retryable, and the orchestrator would walk its whole candidate list for a
 * plan that can never be accepted anywhere. Ticket 0003 section 13 records the
 * inconsistency; do not "tidy" it here.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }

  static capacityExceeded(message: string): HttpError {
    return new HttpError(429, 'capacity_exceeded', message);
  }

  static validationFailed(message: string): HttpError {
    return new HttpError(400, 'validation_failed', message);
  }

  static forbidden(code: string, message: string): HttpError {
    return new HttpError(403, code, message);
  }

  static conflict(code: string, message: string): HttpError {
    return new HttpError(409, code, message);
  }
}
