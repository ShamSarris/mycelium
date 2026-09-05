import { describe, expect, it } from 'vitest';
import {
  cumulative,
  estimateTokens,
  openBudget,
  record,
  reserve,
  totalTokens,
} from '../../src/domain/budget.js';
import { usage } from '../helpers/fakes.js';

/**
 * `limits.tokens` is task-wide across execution attempts (archive T4). The
 * arithmetic that makes that true is here, pure, because getting it wrong is
 * silent: a retry that started its accounting at zero would re-grant the whole
 * ceiling every time and nothing would ever report a limit.
 */

describe('estimateTokens', () => {
  it('over-states rather than under-states', () => {
    // 11 bytes; a real tokenizer gives 2. Guessing low is the dangerous
    // direction — it under-reserves and lets a task overrun.
    expect(estimateTokens('hello world', 3)).toBe(4);
  });

  it('counts bytes, not characters, so multibyte input is not under-counted', () => {
    // Four characters, twelve UTF-8 bytes.
    expect(estimateTokens('日本語だ', 3)).toBe(4);
    expect(estimateTokens('abcd', 3)).toBe(2);
  });

  it('is zero for empty input', () => {
    expect(estimateTokens('', 3)).toBe(0);
  });
});

describe('totalTokens', () => {
  it('counts cached input as spent, because the model consumed it', () => {
    expect(
      totalTokens(
        usage({ inputTokens: 10, cacheReadTokens: 90, cacheWriteTokens: 5, outputTokens: 20 }),
      ),
    ).toBe(125);
  });
});

describe('openBudget', () => {
  it('resumes from the spend the dispatch carries, not from zero', () => {
    const budget = openBudget(100_000, 40_000);

    expect(budget.ceiling).toBe(100_000);
    expect(budget.priorSpend).toBe(40_000);
    expect(budget.attemptSpend).toBe(0);
    expect(cumulative(budget)).toBe(40_000);
  });
});

describe('reserve', () => {
  it('passes a reservation that stays inside the ceiling', () => {
    expect(reserve(openBudget(100_000, 0), 1000, 4000).ok).toBe(true);
  });

  it('refuses one that would cross it, before the call is sent', () => {
    const result = reserve(openBudget(10_000, 0), 4000, 8000);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('limit_exceeded');
    expect(result.message).toContain('10000');
  });

  it('counts the spend already on the task, so a later attempt has less room', () => {
    // The same call that fits on a fresh task does not fit on a retry that has
    // already burned most of the ceiling.
    expect(reserve(openBudget(10_000, 0), 1000, 4000).ok).toBe(true);
    expect(reserve(openBudget(10_000, 8000), 1000, 4000).ok).toBe(false);
  });

  it('reserves the maximum output, not an optimistic guess at it', () => {
    expect(reserve(openBudget(5000, 0), 1000, 4001).ok).toBe(false);
  });
});

describe('record', () => {
  it('replaces the estimate with what the provider reported', () => {
    const after = record(openBudget(100_000, 1000), usage({ inputTokens: 300, outputTokens: 200 }));

    expect(after.attemptSpend).toBe(500);
    expect(cumulative(after)).toBe(1500);
  });

  it('accumulates across turns without touching the prior spend', () => {
    let budget = openBudget(100_000, 1000);
    budget = record(budget, usage({ inputTokens: 100, outputTokens: 100 }));
    budget = record(budget, usage({ inputTokens: 100, outputTokens: 100 }));

    expect(budget.priorSpend).toBe(1000);
    expect(budget.attemptSpend).toBe(400);
    expect(cumulative(budget)).toBe(1400);
  });

  it('leaves the budget it was given untouched', () => {
    const opened = openBudget(100_000, 0);
    record(opened, usage({ inputTokens: 100, outputTokens: 100 }));

    expect(opened.attemptSpend).toBe(0);
  });
});
