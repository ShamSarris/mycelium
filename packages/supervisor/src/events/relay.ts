import type { OrchestratorClient } from '../clients/orchestrator.js';
import type { Spool } from './spool.js';

/** The orchestrator's own cap on a batch. Sending more is a guaranteed 400. */
export const MAX_BATCH = 500;

export interface RelayOutcome {
  delivered: number;
  rejected: number;
  /** Set when the orchestrator was unreachable or failing; the spool is intact. */
  deferred: boolean;
}

/**
 * Moves one batch from the spool to the orchestrator. Called on an interval and
 * once more during teardown, so an agent's terminal event lands before the
 * environment is forgotten.
 *
 * The distinction that matters is between an orchestrator that is down and one
 * that refused the batch. The first is transient and the spool waits. The
 * second is an emitter bug — a malformed envelope, a reused sequence number —
 * which would otherwise wedge every later event behind it forever, so the batch
 * is moved aside and the drain continues.
 */
export async function relayOnce(
  spool: Spool,
  orchestrator: OrchestratorClient,
): Promise<RelayOutcome> {
  const batch = await spool.peek(MAX_BATCH);
  if (batch.length === 0) return { delivered: 0, rejected: 0, deferred: false };

  const result = await orchestrator.postEvents(batch);

  if (result.ok) {
    await spool.commit(batch.length);
    return { delivered: batch.length, rejected: 0, deferred: false };
  }

  if (result.retryable) {
    return { delivered: 0, rejected: 0, deferred: true };
  }

  await spool.reject(batch.length);
  return { delivered: 0, rejected: batch.length, deferred: false };
}
