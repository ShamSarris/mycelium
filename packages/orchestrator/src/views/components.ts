import { escape } from './html.js';

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

/**
 * A state, coloured by what it means rather than by what it is called. Only
 * three things are ever coloured on this dashboard — good, waiting on you,
 * broken — which is what lets a red one be noticed from across a room.
 */
export type Tone = 'ok' | 'warn' | 'bad' | 'mute';

export function pill(label: string, tone: Tone = 'mute'): string {
  return `<span class="pill ${tone}">${escape(label)}</span>`;
}

/**
 * A percentage as a length. The number stays beside it: a bar answers "is this
 * a problem" at a glance and a figure answers "how bad", and neither replaces
 * the other.
 *
 * Clamped, because the only caller that can exceed 100 is CPU saturation,
 * where a full bar is the right picture and the true figure is printed anyway.
 */
export function bar(percent: number, tone: Tone = 'ok'): string {
  const width = Math.max(0, Math.min(100, Math.round(percent)));
  return `<span class="bar ${tone}"><span style="width:${width}%"></span></span>`;
}

/** Green until it matters, amber when it is worth a look, red when it is not. */
export function loadTone(percent: number): Tone {
  if (percent >= 90) return 'bad';
  if (percent >= 75) return 'warn';
  return 'ok';
}
