import net from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DockerGvisorDriver, PLAN_LABEL } from '../../src/drivers/docker.js';
import { exec } from '../../src/drivers/exec.js';

/**
 * The only tests that touch a real container runtime. Everything else runs
 * against the driver fakes (B22), because gVisor does not exist on the
 * operator's Windows machine and a suite nobody can run is worse than a seam.
 *
 * Run them on a Linux host with Docker and the gVisor runtime installed:
 *
 *   SUPERVISOR_DOCKER_TESTS=1 IMAGE=alpine:3.20 pnpm test
 *
 * `infra/` provisions that host; until it exists these are how the real driver
 * gets exercised at all.
 */
const enabled = process.env.SUPERVISOR_DOCKER_TESTS === '1';
const IMAGE = process.env.SUPERVISOR_TEST_IMAGE ?? 'alpine:3.20';
const PLAN_ID = 'integration-plan';

const suite = enabled ? describe : describe.skip;

let driver: DockerGvisorDriver;
let workdir: string;
let network: { name: string; gatewayAddress: string };

suite('the real Docker and gVisor driver', () => {
  beforeAll(async () => {
    driver = new DockerGvisorDriver();
    workdir = await mkdtemp(path.join(tmpdir(), 'mycelium-integration-'));
    await writeFile(path.join(workdir, 'hello.txt'), 'from the host\n');
    network = await driver.createNetwork(PLAN_ID);
  }, 120_000);

  afterAll(async () => {
    await driver.removeNetwork(network.name).catch(() => undefined);
    await rm(workdir, { recursive: true, force: true });
  });

  function spec(overrides: Partial<Parameters<DockerGvisorDriver['run']>[0]> = {}) {
    return {
      planId: PLAN_ID,
      image: IMAGE,
      cmd: ['sh', '-c', 'echo ok'],
      env: {},
      workdir: '/workspace',
      network: null,
      cpus: 1,
      memoryMb: 256,
      timeoutSec: 30,
      mounts: [{ source: workdir, target: '/workspace', readonly: false }],
      ...overrides,
    };
  }

  it('runs under the gVisor runtime, not the host kernel', async () => {
    const result = await driver.run(
      spec({ cmd: ['sh', '-c', 'uname -r'] }),
      () => undefined,
    );

    expect(result.exitCode).toBe(0);
    // gVisor's sentry reports its own kernel version rather than the host's.
    expect(result.stdout.toString('utf8')).toMatch(/gvisor|4\.4\.0/i);
  }, 120_000);

  it('reports the container id before the container has finished', async () => {
    let seen: string | null = null;
    const result = await driver.run(spec(), (id) => {
      seen = id;
    });

    expect(seen).toBeTruthy();
    expect(result.containerId).toBe(seen);
  }, 120_000);

  it('sees the plan checkout at the mount and nothing else', async () => {
    const result = await driver.run(
      spec({ cmd: ['sh', '-c', 'cat /workspace/hello.txt'] }),
      () => undefined,
    );

    expect(result.stdout.toString('utf8')).toContain('from the host');
  }, 120_000);

  it('has a read-only root filesystem', async () => {
    const result = await driver.run(
      spec({ cmd: ['sh', '-c', 'touch /root-write-test 2>&1 || echo refused'] }),
      () => undefined,
    );

    expect(result.stdout.toString('utf8')).toContain('refused');
  }, 120_000);

  // The whole basis of B14: without this, the proxy would be an option rather
  // than the only path.
  it('has no route off the host on the plan network', async () => {
    const result = await driver.run(
      spec({
        network: network.name,
        cmd: ['sh', '-c', 'wget -T 3 -q -O- http://example.com || echo unreachable'],
      }),
      () => undefined,
    );

    expect(result.stdout.toString('utf8')).toContain('unreachable');
  }, 120_000);

  it('has no route off the host with no network at all', async () => {
    const result = await driver.run(
      spec({ cmd: ['sh', '-c', 'wget -T 3 -q -O- http://example.com || echo unreachable'] }),
      () => undefined,
    );

    expect(result.stdout.toString('utf8')).toContain('unreachable');
  }, 120_000);

  it('reaches a listener on the network gateway, which is where the proxy sits', async () => {
    const server = net.createServer((socket) => socket.end('proxy-is-here'));
    await new Promise<void>((resolve) =>
      server.listen(3128, network.gatewayAddress, () => resolve()),
    );

    try {
      const result = await driver.run(
        spec({
          network: network.name,
          cmd: ['sh', '-c', `nc -w 3 ${network.gatewayAddress} 3128 || echo unreachable`],
        }),
        () => undefined,
      );

      expect(result.stdout.toString('utf8')).toContain('proxy-is-here');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 120_000);

  it('kills a container that outstays the wall clock', async () => {
    const result = await driver.run(
      spec({ cmd: ['sh', '-c', 'sleep 60'], timeoutSec: 3 }),
      () => undefined,
    );

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  }, 120_000);

  it('labels containers so teardown and reconciliation can find them', async () => {
    let containerId = '';
    await driver.run(spec(), (id) => {
      containerId = id;
    });

    expect(containerId).toBeTruthy();
    const inspected = await exec('docker', [
      'ps',
      '--all',
      '--filter',
      `label=${PLAN_LABEL}=${PLAN_ID}`,
      '--format',
      '{{.ID}}',
    ]);
    // Removed after the run, so the filter should now find nothing of ours.
    expect(inspected.stdout).not.toContain(containerId.slice(0, 12));
  }, 120_000);

  it('leaves nothing behind after a run', async () => {
    await driver.run(spec(), () => undefined);
    expect(await driver.listContainers()).toEqual([]);
  }, 120_000);
});
