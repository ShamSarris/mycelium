/**
 * Everything the supervisor does to containers, behind one interface (B22).
 * The real implementation shells out to Docker with the gVisor runtime; tests
 * drive an in-memory fake, because gVisor does not run on the operator's
 * machine and a suite nobody can run is worse than a thin seam.
 *
 * The agent never sees any of this. It asks over the RPC socket and the
 * supervisor is the only holder of Docker access on the VM (B6, G3).
 */

export interface Mount {
  source: string;
  target: string;
  readonly: boolean;
}

export interface SandboxSpec {
  planId: string;
  image: string;
  cmd: string[];
  env: Record<string, string>;
  workdir: string;
  /** The plan's internal network, or null for a container with no network at all. */
  network: string | null;
  cpus: number;
  memoryMb: number;
  timeoutSec: number;
  mounts: Mount[];
}

export interface SandboxResult {
  containerId: string;
  exitCode: number | null;
  timedOut: boolean;
  stdout: Buffer;
  stderr: Buffer;
}

export interface RunningContainer {
  containerId: string;
  planId: string;
}

export interface ContainerDriver {
  /**
   * An internal network with no route out and no resolver. The proxy is
   * reachable on its gateway and is the sandbox's only path off the host.
   */
  createNetwork(planId: string): Promise<{ name: string; gatewayAddress: string }>;
  removeNetwork(name: string): Promise<void>;

  /**
   * Runs to completion, or to the wall-clock cap. `onStarted` fires with the
   * container id as soon as there is one, so teardown can find a sandbox that
   * is still running.
   */
  run(spec: SandboxSpec, onStarted: (containerId: string) => void): Promise<SandboxResult>;

  kill(containerId: string): Promise<void>;

  /** Labelled with the plan id, which is what restart reconciliation scans. */
  listContainers(): Promise<RunningContainer[]>;
}
