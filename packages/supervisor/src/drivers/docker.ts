import { spawn } from 'node:child_process';
import type {
  ContainerDriver,
  RunningContainer,
  SandboxResult,
  SandboxSpec,
} from './container.js';
import { exec } from './exec.js';

/** How reconciliation and teardown find a plan's containers and networks. */
export const PLAN_LABEL = 'mycelium.plan';

export interface DockerOptions {
  /** `runsc`. Not a default anyone should be able to omit (G3). */
  runtime?: string;
  /** Bytes of each stream kept before further output is discarded. */
  captureMaxBytes?: number;
  dockerPath?: string;
}

/**
 * The one holder of Docker access on the VM (B6). The plan agent never sees
 * this; it asks over the RPC socket and the supervisor decides.
 *
 * Every flag here is a security property rather than a preference, which is why
 * none of them can be reached from the RPC parameters: the gVisor runtime, an
 * internal network or none at all, a read-only root, dropped capabilities, and
 * a hard wall clock.
 */
export class DockerGvisorDriver implements ContainerDriver {
  private readonly runtime: string;
  private readonly captureMaxBytes: number;
  private readonly docker: string;

  constructor(options: DockerOptions = {}) {
    this.runtime = options.runtime ?? 'runsc';
    this.captureMaxBytes = options.captureMaxBytes ?? 10 * 1024 * 1024;
    this.docker = options.dockerPath ?? 'docker';
  }

  /**
   * `--internal` is the load-bearing flag: it gives the network no route off
   * the host, so the proxy on its gateway is the only way out and there is no
   * DNS side channel (baseline section 7).
   */
  async createNetwork(planId: string): Promise<{ name: string; gatewayAddress: string }> {
    const name = `mycelium-${planId}`;

    const created = await exec(this.docker, [
      'network',
      'create',
      '--internal',
      '--label',
      `${PLAN_LABEL}=${planId}`,
      name,
    ]);

    // A network left behind by a killed supervisor is reused rather than
    // treated as a failure; reconciliation removes the ones nothing claims.
    if (created.code !== 0 && !/already exists/i.test(created.stderr)) {
      throw new Error(`could not create the plan network: ${created.stderr.trim()}`);
    }

    const inspected = await exec(this.docker, [
      'network',
      'inspect',
      name,
      '--format',
      '{{ (index .IPAM.Config 0).Gateway }}',
    ]);
    if (inspected.code !== 0) {
      throw new Error(`could not read the plan network gateway: ${inspected.stderr.trim()}`);
    }

    return { name, gatewayAddress: inspected.stdout.trim() };
  }

  async removeNetwork(name: string): Promise<void> {
    await exec(this.docker, ['network', 'rm', name]);
  }

  async run(
    spec: SandboxSpec,
    onStarted: (containerId: string) => void,
  ): Promise<SandboxResult> {
    const args = [
      'create',
      '--runtime',
      this.runtime,
      '--label',
      `${PLAN_LABEL}=${spec.planId}`,
      '--network',
      spec.network ?? 'none',
      '--read-only',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=512m',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--cpus',
      String(spec.cpus),
      '--memory',
      `${spec.memoryMb}m`,
      '--workdir',
      spec.workdir,
    ];

    for (const mount of spec.mounts) {
      args.push('--mount', `type=bind,source=${mount.source},target=${mount.target}${mount.readonly ? ',readonly' : ''}`);
    }
    for (const [key, value] of Object.entries(spec.env)) {
      args.push('--env', `${key}=${value}`);
    }

    args.push(spec.image, ...spec.cmd);

    const created = await exec(this.docker, args);
    if (created.code !== 0) {
      throw new Error(`could not create the sandbox: ${created.stderr.trim()}`);
    }

    // Created before started, so the id exists before anything runs and
    // teardown can always find the container it is racing.
    const containerId = created.stdout.trim();
    onStarted(containerId);

    try {
      return await this.start(containerId, spec.timeoutSec);
    } finally {
      await exec(this.docker, ['rm', '-f', containerId]);
    }
  }

  async kill(containerId: string): Promise<void> {
    await exec(this.docker, ['kill', containerId]);
  }

  async listContainers(): Promise<RunningContainer[]> {
    const result = await exec(this.docker, [
      'ps',
      '--all',
      '--filter',
      `label=${PLAN_LABEL}`,
      '--format',
      `{{.ID}} {{.Label "${PLAN_LABEL}"}}`,
    ]);
    if (result.code !== 0) return [];

    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const [containerId, planId] = line.split(/\s+/);
        return { containerId: containerId ?? '', planId: planId ?? '' };
      });
  }

  /**
   * Attaches so output is captured as it is produced rather than fetched after
   * the fact, and so a container killed by the wall clock still yields whatever
   * it managed to print.
   */
  private start(containerId: string, timeoutSec: number): Promise<SandboxResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.docker, ['start', '--attach', containerId], { shell: false });

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        void exec(this.docker, ['kill', containerId]);
      }, timeoutSec * 1000);

      child.stdout?.on('data', (chunk: Buffer) => {
        // Capped in memory: a runaway container must not take the supervisor
        // with it. Bytes past the cap are counted and discarded.
        stdoutBytes += chunk.length;
        if (stdoutBytes <= this.captureMaxBytes) stdout.push(chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes <= this.captureMaxBytes) stderr.push(chunk);
      });

      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          containerId,
          exitCode: timedOut ? null : code,
          timedOut,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
        });
      });
    });
  }
}
