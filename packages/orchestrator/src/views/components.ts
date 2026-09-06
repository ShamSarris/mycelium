/**
 * The small pieces more than one page renders.
 *
 * Each one exists because two pages would otherwise have their own copy of it
 * and the two would eventually disagree — which on a dashboard reads as the
 * system disagreeing with itself.
 */

/**
 * Coarse, and deliberately so. An exact age is a number you have to subtract
 * from the clock in your head; "4m ago" is the thing you actually wanted, and
 * the exact timestamp is a `title` away when it matters.
 */
export function ago(now: Date, then: Date | null, never = 'never'): string {
  if (then === null) return never;

  const seconds = Math.max(0, Math.round((now.getTime() - then.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

/** The prefix of a uuid, which is all anyone reads off a screen. */
export function id8(id: string): string {
  return id.slice(0, 8);
}
