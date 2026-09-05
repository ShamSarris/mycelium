import type { Deps } from './deps.js';

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
  try {
    await deps.orchestrator.heartbeat();
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
