import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GiteaConfig } from './clients/gitea.js';
import { loadSecret } from './secrets.js';

/**
 * Configuration comes from the environment behind this one function; the two
 * real secrets do not. B13 delivers them as systemd encrypted credentials read
 * through `loadSecret()`, so the unit file and the process environment carry a
 * password-free database URL and no Gitea token at all. The development
 * fallback in `loadSecret` is what keeps a plain `DATABASE_URL` working.
 */
export interface OrchestratorConfig {
  databaseUrl: string;
  port: number;
  host: string;
  operatorAllowlist: string[];
  gitea: GiteaConfig;
  migrationsDir: string;

  /**
   * Timings the baseline does not fix. Each is a judgement call flagged to the
   * operator in ticket 0002 section 13.
   */
  leaseSeconds: number;
  wallClockGraceMinutes: number;
  supervisorLostMinutes: number;
  heartbeatHealthyMinutes: number;
  dispatcherIntervalMs: number;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Walks up looking for the repo's migrations directory rather than counting
 * path segments: this module runs from `src/` under vitest and from
 * `dist/src/` once built, and those are different depths.
 */
export function defaultMigrationsDir(from: string = HERE): string {
  let dir = from;
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, 'migrations');
    if (existsSync(path.join(candidate, '0001_init.sql'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not find a migrations directory above ${from}`);
}

export const DEFAULT_DATABASE_URL = 'postgres://mycelium:mycelium@localhost:15432/mycelium';

function intFrom(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new Error(`expected an integer, got ${value}`);
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): OrchestratorConfig {
  return {
    databaseUrl: withPassword(env.DATABASE_URL ?? DEFAULT_DATABASE_URL, loadSecret('postgres_password', env)),
    port: intFrom(env.PORT, 8080),
    // Loopback only. The dashboard and MCP surface are reached through
    // Tailscale Serve, which is what makes the injected identity header
    // trustworthy (baseline section 7).
    host: env.HOST ?? '127.0.0.1',
    operatorAllowlist: (env.OPERATOR_ALLOWLIST ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    gitea: {
      baseUrl: env.GITEA_BASE_URL ?? 'http://localhost:3000',
      owner: env.GITEA_OWNER ?? 'mycelium',
      adminToken: loadSecret('gitea_admin_token', env),
    },
    migrationsDir: env.MIGRATIONS_DIR ?? defaultMigrationsDir(),
    leaseSeconds: intFrom(env.LEASE_SECONDS, 60),
    wallClockGraceMinutes: intFrom(env.WALL_CLOCK_GRACE_MIN, 2),
    supervisorLostMinutes: intFrom(env.SUPERVISOR_LOST_MIN, 5),
    heartbeatHealthyMinutes: intFrom(env.HEARTBEAT_HEALTHY_MIN, 2),
    dispatcherIntervalMs: intFrom(env.DISPATCHER_INTERVAL_MS, 2000),
  };
}

/**
 * Puts the credential's password into a URL that carries none. A URL that
 * already has one is left exactly as it is: development and the test harness
 * both pass one inline, and silently rewriting it would be a surprising thing
 * for a config loader to do.
 */
function withPassword(databaseUrl: string, password: string): string {
  if (password === '') return databaseUrl;

  try {
    const url = new URL(databaseUrl);
    if (url.password !== '') return databaseUrl;
    url.password = password;
    return url.toString();
  } catch {
    // Not a URL `URL` can parse — a libpq keyword string, perhaps. Leave it be
    // rather than mangling something the driver understands and this does not.
    return databaseUrl;
  }
}
