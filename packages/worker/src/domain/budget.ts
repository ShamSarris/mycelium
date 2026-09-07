import type { NormalizedUsage } from '../transport/transport.js';

/**
 * Fail-closed budget arithmetic (archive T4), pure.
 *
 * Two rules do all the work. The reservation is made *before* a call, from a
 * deliberately pessimistic estimate, so a call that would cross the ceiling is
 * never sent — checking afterwards would only ever report an overrun that had
 * already been paid for. And the ceiling is task-wide across execution
 * attempts, so a retry resumes from the spend the dispatch carries rather than
 * starting at zero; otherwise every retry would silently re-grant the whole
 * allowance and no task would ever report a limit.
 */

export interface Budget {
  /**
   * `limits.cost_microusd` for this task, task-wide and not per-attempt. Fed
   * in unconverted (ticket 07 decision): this module still does its
   * arithmetic on whatever unit its caller passes.
   */
  readonly ceiling: number;
  /** `cost_spent_so_far_microusd` from the dispatch: what earlier attempts already used. */
  readonly priorSpend: number;
  /** Reconciled from provider-reported usage as this attempt proceeds. */
  readonly attemptSpend: number;
}

export type Reservation =
  | { ok: true; reserved: number }
  | { ok: false; code: 'limit_exceeded'; message: string };

export function openBudget(ceiling: number, tokensSpentSoFar: number): Budget {
  return { ceiling, priorSpend: tokensSpentSoFar, attemptSpend: 0 };
}

export function cumulative(budget: Budget): number {
  return budget.priorSpend + budget.attemptSpend;
}

/**
 * Bytes over a divisor, not a tokenizer. Archive T4 wants the estimate off the
 * hot path, and the divisor is deliberately below the real ratio (nearer 3.5-4
 * bytes per token) so the estimate over-states. Over-reserving costs a refused
 * call; under-reserving costs an overrun nobody notices.
 */
export function estimateTokens(text: string, bytesPerToken: number): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / bytesPerToken);
}

/**
 * Everything the model consumed. Cached input is billed differently but it is
 * still tokens the model read, so it counts against a token ceiling.
 */
export function totalTokens(usage: NormalizedUsage): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens;
}

/**
 * The whole of `maxOutput` is reserved, not a guess at what the model will
 * actually produce. A reservation that assumed a short answer would be a
 * ceiling that holds only while the model is terse.
 */
export function reserve(budget: Budget, estimatedInput: number, maxOutput: number): Reservation {
  const reserved = estimatedInput + maxOutput;
  const projected = cumulative(budget) + reserved;

  if (projected > budget.ceiling) {
    return {
      ok: false,
      code: 'limit_exceeded',
      message:
        `this call would reserve ${reserved} tokens on top of ${cumulative(budget)} already spent, ` +
        `past the task ceiling of ${budget.ceiling}`,
    };
  }

  return { ok: true, reserved };
}

/** Replaces the estimate with what the provider reported. Returns a new budget. */
export function record(budget: Budget, usage: NormalizedUsage): Budget {
  return { ...budget, attemptSpend: budget.attemptSpend + totalTokens(usage) };
}
