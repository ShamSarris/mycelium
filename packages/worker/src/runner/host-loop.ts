import type { Deps } from '../deps.js';
import { runTask } from '../loop/run.js';
import type { TaskDispatch } from '../protocol.js';
import { buildRegistry } from '../tools/registry.js';
import type { ModelTransport } from '../transport/transport.js';
import type { TaskOutcome, TaskRunner } from './runner.js';

/**
 * The first, and for now only, `TaskRunner`: the existing host-owned loop
 * (`loop/run.ts`), unmodified, wrapped behind the seam. Ticket 11's Agent SDK
 * runner is a sibling implementation of the same interface; ticket 14 deletes
 * this one once that lands.
 */
export class HostLoopRunner implements TaskRunner {
  constructor(
    private readonly deps: Deps,
    private readonly transport: ModelTransport,
  ) {}

  async run(dispatch: TaskDispatch, signal: AbortSignal): Promise<TaskOutcome> {
    // Built fresh per task — moved here from `task.ts` — so the commit-cadence
    // counter inside it starts fresh and cannot leak from one task into the
    // next.
    const tools = buildRegistry(this.deps);
    return runTask({ ...this.deps, transport: this.transport }, dispatch, tools, signal);
  }
}
