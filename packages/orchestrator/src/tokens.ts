import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Per-plan secrets exist only between approval and dispatch, and only in this
 * process. Baseline section 7 requires that they are never at rest: Postgres
 * holds the hash, this cache holds the plaintext, and nothing else sees either
 * until the plan dispatch carries the token to the supervisor.
 *
 * A restart empties the cache. That is deliberate rather than a gap: the
 * dispatcher mints a replacement and rewrites the hash in the same transaction,
 * so an orchestrator restart costs a new token, not a stuck plan.
 */
export interface PlanSecrets {
  orchestratorToken: string;
  giteaBotToken: string;
}

export class TokenCache {
  private readonly byPlan = new Map<string, PlanSecrets>();

  get(planId: string): PlanSecrets | undefined {
    return this.byPlan.get(planId);
  }

  set(planId: string, secrets: PlanSecrets): void {
    this.byPlan.set(planId, secrets);
  }

  delete(planId: string): void {
    this.byPlan.delete(planId);
  }

  clear(): void {
    this.byPlan.clear();
  }

  get size(): number {
    return this.byPlan.size;
  }
}

export function mintToken(): string {
  return randomBytes(32).toString('hex');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time comparison, so a bearer token cannot be recovered by timing. */
export function tokenMatches(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashToken(token), 'hex');
  let expected: Buffer;
  try {
    expected = Buffer.from(expectedHash, 'hex');
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
