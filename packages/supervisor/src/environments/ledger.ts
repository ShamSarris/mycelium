import type { AgentHandle } from '../drivers/process.js';
import type { EnvironmentState } from '../domain/states.js';
import { assertTransition } from '../domain/states.js';

/**
 * The supervisor's only mutable state, and it is deliberately in memory: the
 * orchestrator owns the durable truth, and a restart rebuilds this by scanning
 * the VM and asking for its assignments. Nothing here needs to survive a crash
 * (baseline section 4).
 */
export interface Environment {
  planId: string;
  state: EnvironmentState;
  /** `<stateDir>/plans/<planId>` — checkout, sockets, scratch. */
  root: string;
  workdir: string;
  agent: AgentHandle;
  network: string;
  /** The plan's own CONNECT proxy, the sandbox's only path out (B14). */
  proxyUrl: string;
  brokerSocket: string;
  /** Standing set plus the plan's declared list, resolved once at dispatch. */
  egress: string[];
  ttlExpiresAt: Date;
  /** Container ids currently running for this plan. */
  sandboxes: Set<string>;
}

export class Ledger {
  private readonly environments = new Map<string, Environment>();

  get size(): number {
    return this.environments.size;
  }

  has(planId: string): boolean {
    return this.environments.has(planId);
  }

  get(planId: string): Environment | undefined {
    return this.environments.get(planId);
  }

  list(): Environment[] {
    return [...this.environments.values()];
  }

  add(environment: Environment): void {
    this.environments.set(environment.planId, environment);
  }

  remove(planId: string): void {
    this.environments.delete(planId);
  }

  /** Refuses anything outside the table, so no handler can invent a state. */
  transition(planId: string, to: EnvironmentState): void {
    const environment = this.environments.get(planId);
    if (environment === undefined) return;
    assertTransition(environment.state, to);
    environment.state = to;
  }
}
