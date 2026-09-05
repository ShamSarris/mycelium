import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import type { AgentHandle, AgentRunner, AgentSpec } from './process.js';
import { listenAddress } from '../rpc/broker.js';

export interface RunnerOptions {
  /**
   * How to start a plan agent, as argv. The plan agent is baseline step 4 and
   * does not exist yet, so this is configuration rather than a constant and the
   * supervisor says so plainly when it is unset.
   */
  command: string[];
  /**
   * When set, the agent is started under `systemd-run --scope` in this slice,
   * which is what applies the cgroup limits baseline section 4 asks for.
   * Without it the process still gets its own group but no resource ceiling.
   */
  slice?: string;
  memoryMax?: string;
  cpuQuota?: string;
}

/**
 * Starts the plan agent in its own process group so a signal reaches the whole
 * tree — a shell child must not be able to outlive its parent — and, where
 * systemd is available, inside a scope that caps its CPU and memory so one plan
 * cannot starve the supervisor or the plan beside it.
 *
 * The user namespace and the finer cgroup properties are unit-file concerns and
 * land with `infra/`; this is the seam they attach to.
 */
export class CgroupAgentRunner implements AgentRunner {
  private readonly processes = new Map<string, ChildProcess>();

  constructor(private readonly options: RunnerOptions) {}

  async start(spec: AgentSpec): Promise<AgentHandle> {
    if (this.options.command.length === 0) {
      throw new Error(
        'AGENT_COMMAND is not set: the plan agent is baseline step 4 and this node has nothing to start',
      );
    }

    const [command, ...rest] = this.wrap(spec);

    const child = spawn(command as string, rest, {
      cwd: spec.cwd,
      // Deliberate injection. B13's guarantee is that the supervisor's own
      // environment holds no secrets to inherit; this hands over exactly what
      // the plan needs and nothing else, so PATH and friends do not leak.
      env: spec.env,
      detached: true,
      stdio: 'ignore',
      shell: false,
    });
    child.unref();

    this.processes.set(spec.planId, child);
    child.on('exit', () => this.processes.delete(spec.planId));

    return new SpawnedAgent(spec.planId, child, spec.dispatchSocket);
  }

  /**
   * A 500 ms question over the dispatch socket. Anything but a well-formed
   * answer naming this plan is a null, because adopting on a maybe produces a
   * plan that looks alive and answers nothing.
   */
  async probe(planId: string, dispatchSocket: string): Promise<AgentHandle | null> {
    const result = (await call(dispatchSocket, { method: 'agent.ping' }, 500)) as {
      plan_id?: unknown;
    } | null;

    if (result === null || result.plan_id !== planId) return null;

    return new AdoptedAgent(planId, dispatchSocket, (id, signal) => this.signalScope(id, signal));
  }

  async listRunning(): Promise<string[]> {
    return [...this.processes.keys()];
  }

  async kill(planId: string): Promise<void> {
    const child = this.processes.get(planId);
    if (child?.pid !== undefined) {
      killGroup(child.pid, 'SIGKILL');
      this.processes.delete(planId);
      return;
    }

    // No child object, so this is a plan a previous instance of this process
    // started. The scope name is the only handle left, which is why `start`
    // names it deterministically.
    await this.signalScope(planId, 'SIGKILL');
  }

  /**
   * Signals the plan's systemd scope. Without a configured slice there is no
   * scope and nothing to signal — an orphan then outlives the supervisor until
   * the VM is rebooted. Acceptable only because a slice is what every unit file
   * will set; recorded as a gap rather than papered over.
   */
  private async signalScope(planId: string, signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
    if (this.options.slice === undefined) return;

    await new Promise<void>((resolve) => {
      const child = spawn(
        'systemctl',
        ['kill', `--signal=${signal}`, '--kill-whom=all', `mycelium-plan-${planId}.scope`],
        { stdio: 'ignore' },
      );
      child.on('error', () => resolve());
      child.on('exit', () => resolve());
    });
  }

  private wrap(spec: AgentSpec): string[] {
    if (this.options.slice === undefined) return this.options.command;

    const scope = [
      'systemd-run',
      '--scope',
      '--quiet',
      `--slice=${this.options.slice}`,
      `--unit=mycelium-plan-${spec.planId}`,
    ];
    if (this.options.memoryMax !== undefined) {
      scope.push(`--property=MemoryMax=${this.options.memoryMax}`);
    }
    if (this.options.cpuQuota !== undefined) {
      scope.push(`--property=CPUQuota=${this.options.cpuQuota}`);
    }

    return [...scope, ...this.options.command];
  }
}

class SpawnedAgent implements AgentHandle {
  private exited = false;

  constructor(
    readonly planId: string,
    private readonly child: ChildProcess,
    private readonly dispatchSocket: string,
  ) {
    child.on('exit', () => {
      this.exited = true;
    });
  }

  /**
   * The supervisor connects out to the agent for task dispatch, rather than
   * pushing down the broker socket it serves. Two sockets, each with one
   * direction, is easier to reason about than one multiplexed both ways.
   */
  dispatch(task: unknown): Promise<boolean> {
    return call(this.dispatchSocket, { method: 'task.dispatch', params: task }).then(
      (result) => (result as { accepted?: boolean } | null)?.accepted === true,
    );
  }

  async signal(signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
    if (this.child.pid === undefined || this.exited) return;
    killGroup(this.child.pid, signal);
  }

  hasExited(): boolean {
    return this.exited;
  }
}

/**
 * A plan agent this process did not start, re-attached after a restart.
 *
 * Dispatch is unchanged, because it was only ever a socket. What is missing is
 * the child-process object, so `signal` goes through the same systemd scope
 * `start` put it in, and `hasExited` is answered by the socket rather than by a
 * process event. That asymmetry is real and is gap 7 of ticket 0004: only the
 * Linux integration suite exercises it against a live process.
 */
class AdoptedAgent implements AgentHandle {
  private exited = false;

  constructor(
    readonly planId: string,
    private readonly dispatchSocket: string,
    private readonly killScope: (planId: string, signal: 'SIGTERM' | 'SIGKILL') => Promise<void>,
  ) {}

  async dispatch(task: unknown): Promise<boolean> {
    const result = await call(this.dispatchSocket, { method: 'task.dispatch', params: task });
    if (result === null) {
      // The socket is the only thing holding this handle together. Losing it
      // means the agent is gone, whatever the process table says.
      this.exited = true;
      return false;
    }
    return (result as { accepted?: boolean }).accepted === true;
  }

  async signal(signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
    if (this.exited) return;
    await this.killScope(this.planId, signal);
    if (signal === 'SIGKILL') this.exited = true;
  }

  hasExited(): boolean {
    return this.exited;
  }
}

/**
 * One request per connection, one JSON answer, close — the agent's half of the
 * protocol the broker already speaks. Returns the envelope's `result` on
 * success and null on anything else, so every caller treats a refusal and an
 * unreachable agent the same way.
 */
function call(socketPath: string, request: unknown, timeoutMs = 5000): Promise<unknown> {
  return new Promise((resolve) => {
    const socket = net.createConnection(listenAddress(socketPath), () => {
      socket.end(`${JSON.stringify(request)}\n`);
    });

    let response = '';
    socket.on('data', (chunk: Buffer) => {
      response += chunk.toString('utf8');
    });
    socket.on('error', () => resolve(null));
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      resolve(null);
    });
    socket.on('close', () => {
      try {
        const parsed = JSON.parse(response) as { ok?: boolean; result?: unknown };
        resolve(parsed.ok === true ? (parsed.result ?? null) : null);
      } catch {
        resolve(null);
      }
    });
  });
}

/** The negative pid is the point: it signals the group, not just the leader. */
function killGroup(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone. Teardown must tolerate that.
    }
  }
}
