import type { Deps } from './deps.js';
import type { HostMetrics } from './metrics.js';

/**
 * The periodic work, written as single ticks so tests drive them directly with
 * a controlled clock. `startLoops` in index.ts is the only thing that owns a
 * timer, exactly as the orchestrator's dispatcher does.
 */

/**
 * Two minutes of silence marks this VM unhealthy orchestrator-side and it stops
 * receiving dispatch, so a heartbeat failure must never take the process with
 * it — the next tick is thirty seconds away and the network may well be back.
 */
export async function heartbeatOnce(deps: Deps): Promise<boolean> {
  // Collected in its own try/catch, and outside the one below, so a collector
  // that fails costs this VM a graph on a dashboard and nothing else. The
  // heartbeat goes out either way.
  let metrics: HostMetrics | undefined;
  try {
    metrics = await deps.metrics();
  } catch {
    metrics = undefined;
  }

  try {
    await deps.orchestrator.heartbeat(metrics);
    return true;
  } catch (error) {
    await deps.events.emit({
      source: 'supervisor',
      type: 'error',
      severity: 'warn',
      payload: { stage: 'heartbeat', message: (error as Error).message },
    });
    return false;
  }
}
