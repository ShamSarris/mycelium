/**
 * Configuration comes from the environment behind this one function, exactly as
 * it does in the orchestrator. Secrets are the exception: they are read through
 * `loadSecret` (B13) and never appear here.
 */
export interface SupervisorConfig {
  /** The `agents` row this daemon is. Minted by the orchestrator's register script. */
  supervisorId: string;
  orchestratorUrl: string;
  /** Tailnet addresses allowed to reach the dispatch routes (B19). */
  orchestratorPeers: string[];

  host: string;
  port: number;
  /** Test-only. No unit file sets it; see the bind rule below. */
  allowInsecureBind: boolean;

  stateDir: string;

  maxEnvironments: number;
  maxSandboxesPerEnvironment: number;

  sandboxImages: string[];
  sandboxCpus: number;
  sandboxMemoryMb: number;
  sandboxTimeoutSec: number;
  sandboxTimeoutCeilingSec: number;

  outputHeadBytes: number;
  outputTailBytes: number;
  outputMaxBytes: number;

  /** Always permitted alongside the plan's own list: Gitea and the registries. */
  standingEgress: string[];

  heartbeatIntervalMs: number;
  relayIntervalMs: number;
  spoolMaxBytes: number;

  /** Grace between SIGTERM and SIGKILL of the plan agent (B15). */
  teardownGraceMs: number;
  /** How far past a plan's TTL the supervisor waits before tearing down itself. */
  ttlGraceMinutes: number;
}

const WILDCARD_BINDS = new Set(['0.0.0.0', '::', '*']);

const DEFAULT_STANDING_EGRESS = [
  'registry.npmjs.org',
  'pypi.org',
  'files.pythonhosted.org',
];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SupervisorConfig {
  const allowInsecureBind = env.ALLOW_INSECURE_BIND === '1';
  const host = required(env.HOST, 'HOST');

  // B19 is only authentication because this process is on the tailnet
  // interface and nowhere else: a packet arriving there cannot forge its
  // source address. On a wildcard bind, one arriving on any other interface
  // can, and the peer allowlist becomes decoration. Fail at boot rather than
  // serve dispatch to whoever asks.
  if (WILDCARD_BINDS.has(host) && !allowInsecureBind) {
    throw new Error(
      `HOST is ${host}, which binds every interface and defeats the peer allowlist (B19). Bind the tailnet address.`,
    );
  }

  const orchestratorPeers = list(env.ORCHESTRATOR_PEERS);
  if (orchestratorPeers.length === 0) {
    throw new Error('ORCHESTRATOR_PEERS is empty, which would authorise every caller (B19)');
  }

  return {
    supervisorId: required(env.SUPERVISOR_ID, 'SUPERVISOR_ID'),
    orchestratorUrl: required(env.ORCHESTRATOR_URL, 'ORCHESTRATOR_URL').replace(/\/$/, ''),
    orchestratorPeers,

    host,
    port: integer(env.PORT, 'PORT', 8081, 1),
    allowInsecureBind,

    stateDir: env.STATE_DIR ?? '/var/lib/mycelium',

    maxEnvironments: integer(env.MAX_ENVIRONMENTS, 'MAX_ENVIRONMENTS', 2, 1),
    maxSandboxesPerEnvironment: integer(
      env.MAX_SANDBOXES_PER_ENVIRONMENT,
      'MAX_SANDBOXES_PER_ENVIRONMENT',
      4,
      1,
    ),

    sandboxImages: list(env.SANDBOX_IMAGES),
    sandboxCpus: integer(env.SANDBOX_CPUS, 'SANDBOX_CPUS', 1, 1),
    sandboxMemoryMb: integer(env.SANDBOX_MEMORY_MB, 'SANDBOX_MEMORY_MB', 1024, 64),
    sandboxTimeoutSec: integer(env.SANDBOX_TIMEOUT_SEC, 'SANDBOX_TIMEOUT_SEC', 300, 1),
    sandboxTimeoutCeilingSec: integer(
      env.SANDBOX_TIMEOUT_CEILING_SEC,
      'SANDBOX_TIMEOUT_CEILING_SEC',
      3600,
      1,
    ),

    outputHeadBytes: integer(env.OUTPUT_HEAD_BYTES, 'OUTPUT_HEAD_BYTES', 8192, 0),
    outputTailBytes: integer(env.OUTPUT_TAIL_BYTES, 'OUTPUT_TAIL_BYTES', 8192, 0),
    outputMaxBytes: integer(env.OUTPUT_MAX_BYTES, 'OUTPUT_MAX_BYTES', 10 * 1024 * 1024, 1),

    standingEgress: (env.STANDING_EGRESS === undefined
      ? DEFAULT_STANDING_EGRESS
      : list(env.STANDING_EGRESS)
    ).map((host) => host.toLowerCase()),

    heartbeatIntervalMs: integer(env.HEARTBEAT_INTERVAL_MS, 'HEARTBEAT_INTERVAL_MS', 30_000, 1),
    relayIntervalMs: integer(env.RELAY_INTERVAL_MS, 'RELAY_INTERVAL_MS', 2000, 1),
    spoolMaxBytes: integer(env.SPOOL_MAX_BYTES, 'SPOOL_MAX_BYTES', 1024 * 1024 * 1024, 1),

    teardownGraceMs: integer(env.TEARDOWN_GRACE_MS, 'TEARDOWN_GRACE_MS', 5000, 0),
    ttlGraceMinutes: integer(env.TTL_GRACE_MIN, 'TTL_GRACE_MIN', 5, 0),
  };
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function integer(
  value: string | undefined,
  name: string,
  fallback: number,
  minimum: number,
): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || String(parsed) !== value.trim()) {
    throw new Error(`${name} must be an integer, got ${value}`);
  }
  if (parsed < minimum) {
    throw new Error(`${name} must be at least ${minimum}, got ${parsed}`);
  }
  return parsed;
}
