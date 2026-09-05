import type { ValidationIssue } from '@mycelium/contracts';

/**
 * Every route failure is one of these, so the error shape on the wire is
 * uniform: `{ error: { code, message, issues? } }`.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues?: ValidationIssue[],
  ) {
    super(message);
    this.name = 'HttpError';
  }

  static badRequest(code: string, message: string, issues?: ValidationIssue[]): HttpError {
    return new HttpError(400, code, message, issues);
  }

  static unauthorized(message: string): HttpError {
    return new HttpError(401, 'unauthorized', message);
  }

  static forbidden(message: string): HttpError {
    return new HttpError(403, 'forbidden', message);
  }

  static notFound(what: string): HttpError {
    return new HttpError(404, 'not_found', `${what} not found`);
  }

  static conflict(code: string, message: string): HttpError {
    return new HttpError(409, code, message);
  }
}
