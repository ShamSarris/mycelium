/**
 * B21: capacity is one configured integer. The orchestrator's first-fit
 * selection (B12) is an optimisation and this rejection is the correctness
 * mechanism, so it is deliberately something an operator can reason about
 * rather than a live headroom sample that flaps under the pressure it is meant
 * to detect.
 *
 * `live` can exceed `max` after a restart scan finds more than the configured
 * cap, so the comparison is `<`, never `!==`.
 */
export function canAdmit(live: number, max: number): boolean {
  return live < max;
}

export function canLaunchSandbox(live: number, max: number): boolean {
  return live < max;
}
