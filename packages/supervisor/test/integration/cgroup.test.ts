import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { CgroupAgentRunner } from '../../src/drivers/cgroup.js';
import type { AgentSpec } from '../../src/drivers/process.js';

/**
 * Ticket 15 / Q5: the Agent SDK's own abort/cleanup path can orphan the
 * `claude` subprocess it spawned (confirmed live in `01-findings.md`'s Q5 —
 * both of the SDK's internal teardown timers are `.unref()`'d, so a parent
 * that exits before they fire leaves the child running with nothing left to
 * kill it). B15's five-second guarantee is therefore load-bearing on the
 * supervisor's own external kill of the whole `systemd-run --scope`, not on
 * anything the agent process or the SDK does internally.
 *
 * These are the only tests that exercise the real `CgroupAgentRunner` against
 * a real systemd scope, for the same reason `integration/docker.test.ts`
 * gates on Docker/gVisor: neither exists on the operator's Windows machine.
 *
 * Run on a Linux host with systemd (systemd-run, systemctl) as root, or a
 * user with polkit rights to manage its own scopes — non-root hit
 * "Interactive authentication required" during the Q5 spike:
 *
 *   SUPERVISOR_SYSTEMD_TESTS=1 pnpm test -- packages/supervisor/test/integration/cgroup.test.ts
 *
 * (On this repo's Windows dev machine, WSL2 Ubuntu with systemd as PID 1 —
 * `wsl -d Ubuntu -u root` — is what these were actually run against; see the
 * completion report for the real, live output.)
 */
const enabled = process.env.SUPERVISOR_SYSTEMD_TESTS === '1';
const suite = enabled ? describe : describe.skip;

const SLICE = process.env.SUPERVISOR_TEST_SLICE ?? 'mycelium-test-slice';
const FIXTURE = fileURLToPath(new URL('./fixtures/spawn-grandchild.mjs', import.meta.url));

/** POSIX-only: signal 0 throws ESRCH/EPERM-free iff the process is gone. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for condition`);
}

async function grandchildPid(pidFile: string): Promise<number> {
  let pid: number | undefined;
  await waitUntil(async () => {
    try {
      pid = Number(await readFile(pidFile, 'utf8'));
      return Number.isInteger(pid) && pid > 0;
    } catch {
      return false;
    }
  }, 10_000);
  return pid as number;
}

let workdir: string;

beforeAll(async () => {
  workdir = await mkdtemp(path.join(tmpdir(), 'mycelium-cgroup-'));
});

function specFor(planId: string, pidFile: string): AgentSpec {
  return {
    planId,
    cwd: workdir,
    env: { CHILD_PID_FILE: pidFile },
    brokerSocket: path.join(workdir, `${planId}-broker.sock`),
    dispatchSocket: path.join(workdir, `${planId}-dispatch.sock`),
  };
}

suite('CgroupAgentRunner - the scope kill reaches child processes', () => {
  // The path `environments/teardown.ts` actually calls for an agent this
  // supervisor process started itself (the common case: `SpawnedAgent.signal`
  // -> `killGroup` -> `process.kill(-pid, signal)`, a POSIX process-group
  // kill of the `systemd-run --scope` child and everything in its group).
  it('killGroup kills a grandchild process spawned inside the scope', async () => {
    const runner = new CgroupAgentRunner({ command: ['node', FIXTURE], slice: SLICE });
    const planId = `killgroup-${Date.now()}`;
    const pidFile = path.join(workdir, `${planId}.pid`);

    const handle = await runner.start(specFor(planId, pidFile));
    const childPid = await grandchildPid(pidFile);
    expect(isAlive(childPid)).toBe(true);

    await handle.signal('SIGKILL');
    await waitUntil(() => !isAlive(childPid), 10_000);

    expect(isAlive(childPid)).toBe(false);
  }, 30_000);

  // The path used to reclaim a plan with no live in-memory handle — a
  // restarted supervisor, or an orphan found during reconciliation
  // (`AdoptedAgent.signal` / `kill()`'s fallback -> `signalScope` ->
  // `systemctl kill --signal=... --kill-whom=all <scope>`).
  it('signalScope (systemctl kill --kill-whom=all) kills a grandchild process spawned inside the scope', async () => {
    const runnerA = new CgroupAgentRunner({ command: ['node', FIXTURE], slice: SLICE });
    const planId = `signalscope-${Date.now()}`;
    const pidFile = path.join(workdir, `${planId}.pid`);

    await runnerA.start(specFor(planId, pidFile));
    const childPid = await grandchildPid(pidFile);
    expect(isAlive(childPid)).toBe(true);

    // A fresh runner instance never tracked this plan's process, exactly
    // like a restarted supervisor — so `kill()` has no in-memory handle and
    // falls through to signalling the scope by its deterministic name.
    const runnerB = new CgroupAgentRunner({ command: ['node', FIXTURE], slice: SLICE });
    await runnerB.kill(planId);

    await waitUntil(() => !isAlive(childPid), 10_000);

    expect(isAlive(childPid)).toBe(false);
  }, 30_000);
});
