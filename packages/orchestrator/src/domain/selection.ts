/**
 * Supervisor selection (decision B12): first-fit over healthy candidates,
 * ordered by priority then id.
 *
 * Selection is an optimisation, not a correctness mechanism. The supervisor
 * owns capacity truth and rejects when full, so a poor pick self-corrects on
 * the next candidate. Nothing here consults capacity.
 */

export interface SupervisorCandidate {
  id: string;
  name: string;
  env: string;
  base_url: string;
  enabled: boolean;
  priority: number;
  last_heartbeat_at: Date | null;
}

/** Baseline section 10: a VM is unhealthy after two minutes of silence. */
export const HEARTBEAT_HEALTHY_MS = 2 * 60 * 1000;

export interface SelectionOptions {
  env: string;
  now: Date;
  healthyWithinMs?: number;
}

export function isHealthy(
  candidate: SupervisorCandidate,
  now: Date,
  healthyWithinMs = HEARTBEAT_HEALTHY_MS,
): boolean {
  if (candidate.last_heartbeat_at === null) return false;
  return now.getTime() - candidate.last_heartbeat_at.getTime() <= healthyWithinMs;
}

/**
 * Returns the candidates eligible for `env`, in the order the dispatcher should
 * try them. An empty result means the plan stays queued and selection re-runs
 * after backoff.
 */
export function selectSupervisors(
  candidates: readonly SupervisorCandidate[],
  options: SelectionOptions,
): SupervisorCandidate[] {
  const { env, now, healthyWithinMs = HEARTBEAT_HEALTHY_MS } = options;

  return candidates
    .filter((c) => c.env === env && c.enabled && isHealthy(c, now, healthyWithinMs))
    .sort((a, b) => (a.priority !== b.priority ? a.priority - b.priority : a.id.localeCompare(b.id)));
}
