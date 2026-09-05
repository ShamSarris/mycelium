import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * The on-disk half of an environment.
 *
 * The ledger is in memory because the orchestrator owns the durable truth
 * (baseline section 4), and that stayed true right up until re-attachment
 * needed it not to be. `GET /supervisors/:id/assignments` returns a plan id, a
 * state and a project id — not the egress list, the TTL, the network name, or
 * the workdir — so a restarted supervisor cannot rebuild a ledger entry from
 * the orchestrator alone, and an adopted plan with no egress list would be a
 * plan whose proxy allows nothing.
 *
 * This is therefore a cache of what dispatch already decided, not a second
 * source of truth: everything in it came from the orchestrator, and a record
 * for a plan the orchestrator no longer places here is ignored and deleted.
 *
 * It holds no secrets. The bot token, the orchestrator token, and the model key
 * are injected into a fresh agent at provision time and an adopted agent
 * already has its own; writing them here would put three credentials on disk
 * for the lifetime of the VM to buy nothing.
 */
export interface EnvironmentRecord {
  plan_id: string;
  root: string;
  workdir: string;
  network: string;
  /** Where the plan's proxy binds. Persisted so adoption needs no Docker inspect. */
  gateway_address: string;
  broker_socket: string;
  dispatch_socket: string;
  egress: string[];
  ttl_expires_at: string;
}

const FILENAME = 'environment.json';

export function recordPath(root: string): string {
  return path.join(root, 'run', FILENAME);
}

export async function writeRecord(record: EnvironmentRecord): Promise<void> {
  const target = recordPath(record.root);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

export async function readRecord(root: string): Promise<EnvironmentRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(recordPath(root), 'utf8')) as EnvironmentRecord;
    // A half-written record from a crash mid-provision is worse than none: it
    // would adopt a plan into an environment that was never finished.
    if (
      typeof parsed.plan_id !== 'string' ||
      typeof parsed.dispatch_socket !== 'string' ||
      typeof parsed.broker_socket !== 'string' ||
      typeof parsed.network !== 'string' ||
      !Array.isArray(parsed.egress)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Every plan directory this node has on disk. Discovery starts here rather
 * than from the running process table, because after a restart this process
 * started none of them.
 */
export async function listRecordedPlans(stateDir: string): Promise<string[]> {
  try {
    const entries = await readdir(path.join(stateDir, 'plans'), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}
