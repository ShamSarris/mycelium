/**
 * The only currency formatter in the dashboard. Storage is microusd (integer
 * millionths of a US dollar); every page converts at the view boundary, never
 * in the query — see `services/{plans,monitor,projects}.ts`, which hand back
 * microusd integers for this to render.
 */

/** One cent, in microusd. */
const MICROUSD_PER_CENT = 10_000;
/** One dollar, in microusd. */
const MICROUSD_PER_DOLLAR = 1_000_000;
/** Below this, cents; at or above it, whole dollars. */
const WHOLE_DOLLAR_THRESHOLD = 10;

/**
 * microusd -> a display string.
 *
 * Rounding rule (a product decision — see ticket 06 §9 for the reasoning):
 * under $10, cents to two decimal places (`$4.20`); at or above $10, whole
 * dollars with a thousands separator (`$1,204`) — an operator scanning for
 * the shape of spend does not need cents once the number has four digits.
 * Zero renders as `$0.00`, but anything greater than zero and less than a
 * whole cent renders as `<$0.01` rather than rounding down to `$0.00`: a task
 * that cost something must never render as free.
 */
export function formatCost(microusd: number): string {
  if (microusd === 0) return '$0.00';

  if (microusd > 0 && microusd < MICROUSD_PER_CENT) return '<$0.01';

  const dollars = microusd / MICROUSD_PER_DOLLAR;

  if (Math.abs(dollars) < WHOLE_DOLLAR_THRESHOLD) {
    return `$${dollars.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }

  return `$${dollars.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}
