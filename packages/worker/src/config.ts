import path from 'node:path';

/**
 * Configuration comes from the environment behind this one function, exactly as
 * it does in the orchestrator and the supervisor. The difference here is that
 * three secrets are part of it: the supervisor injects them deliberately into
 * this process (B13 — its own environment holds none for a child to inherit),
 * so `loadSecret` has no counterpart on this side. They are nested under
 * `credentials` to keep the flat config loggable and to leave one field to
 * redact rather than three.
 *
 * A missing variable throws at boot. The supervisor populates all of them
 * ([environments/provision.ts]), so a gap is a supervisor bug, and an agent
 * that started anyway would accept a task and fail it later.
 */

/** The API's effort levels. Anything else is a 400 at the first model call. */
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export type ModelEffort = (typeof EFFORT_LEVELS)[number];

/**
 * Exported so the config tests can assert on the whole set rather than a
 * hand-copied list that drifts from the loader.
 */
export const REQUIRED_VARIABLES = [
  'PLAN_ID',
  'PROJECT_ID',
  'PROJECT_NAME',
  'ORCHESTRATOR_URL',
  'ORCHESTRATOR_TOKEN',
  'GITEA_BOT_TOKEN',
  'GITEA_BRANCH',
  'MODEL_API_KEY',
  'AGENT_SOCKET',
  'DISPATCH_SOCKET',
  'WORKDIR',
] as const;

/** Never log this object. The rest of the config is safe; this is not. */
export interface Credentials {
  /** Per-plan orchestrator API token. Authorises the task-status route only. */
  orchestratorToken: string;
  /** Per-plan Gitea bot token. Repo-scoped; containment is branch protection (D19). */
  giteaBotToken: string;
  modelApiKey: string;
}

export interface WorkerConfig {
  planId: string;
  projectId: string;
  projectName: string;

  orchestratorUrl: string;
  /** The supervisor's broker socket. Sandbox launches and event emission. */
  brokerSocket: string;
  /** This agent's own listener. Task dispatch and the re-attachment probe. */
  dispatchSocket: string;
  /** The repo checkout: the agent's cwd, the file tools' root, the sandbox mount. */
  workdir: string;
  /** `plan/<id>`. The only branch this agent may push. */
  branch: string;

  /**
   * Per-plan directory for the Agent SDK's own Claude Code state (sessions,
   * auto-memory files it might otherwise consult, connector config). Ticket
   * 11 §3: isolation is mandatory, and `settingSources: []` alone does not
   * suppress auto-memory or claude.ai connectors — this env var is one of
   * the four settings that do, alongside `persistSession: false`,
   * `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, and `ENABLE_CLAUDEAI_MCP_SERVERS=false`.
   * Defaults outside the checkout (a sibling of `workdir`, never inside it),
   * per-plan, so the VM's real `~/.claude` never influences an
   * operator-approved plan even before ticket 15 (infra) injects a real one.
   */
  claudeConfigDir: string;

  modelId: string;
  modelEffort: ModelEffort;
  /** Hard upper bound on main-agent API round trips for one task execution. */
  maxTurns: number;

  brokerTimeoutMs: number;
  orchestratorTimeoutMs: number;
  /**
   * B15 gives the whole shutdown five seconds, the terminal event is flushed
   * to the local spool first, and this crosses the network. Best-effort by
   * design — the orchestrator's lease expiry is the backstop.
   */
  shutdownStatusTimeoutMs: number;
  statusRetryLimit: number;
  statusRetryWindowMs: number;
  /**
   * How long shutdown waits for the task in flight to stop. Under B15's five
   * seconds with margin, because the SIGKILL behind it is not negotiable.
   */
  shutdownGraceMs: number;

  /** Tool calls since the last commit before one warn-only event is emitted. */
  commitCadenceWarnAfter: number;
  /**
   * Ticket 13: how many Agent SDK subagents this plan's `query()` may run
   * concurrently, passed straight through to `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`
   * (`runner/agent-sdk.ts`). Deliberately NOT read from the plan — the
   * operator has no visibility into the VM's memory, only the supervisor
   * does (it sets the `systemd-run --scope` `MemoryMax` this is derived
   * from). The supervisor computes the value with
   * `deriveMaxConcurrentSubagents` (`packages/supervisor/src/domain/concurrency.ts`)
   * and injects it as `MAX_CONCURRENT_SUBAGENTS`; the fallback below only
   * matters when nothing injects it (local dev, or a test), and mirrors
   * that function's own conservative default for an unbounded scope.
   */
  maxConcurrentSubagents: number;

  credentials: Credentials;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  for (const name of REQUIRED_VARIABLES) {
    required(env[name], name);
  }

  return {
    planId: required(env.PLAN_ID, 'PLAN_ID'),
    projectId: required(env.PROJECT_ID, 'PROJECT_ID'),
    projectName: required(env.PROJECT_NAME, 'PROJECT_NAME'),

    orchestratorUrl: required(env.ORCHESTRATOR_URL, 'ORCHESTRATOR_URL').replace(/\/$/, ''),
    brokerSocket: required(env.AGENT_SOCKET, 'AGENT_SOCKET'),
    dispatchSocket: required(env.DISPATCH_SOCKET, 'DISPATCH_SOCKET'),
    workdir: required(env.WORKDIR, 'WORKDIR'),
    branch: required(env.GITEA_BRANCH, 'GITEA_BRANCH'),

    claudeConfigDir:
      env.CLAUDE_CONFIG_DIR?.trim() ||
      path.join(path.dirname(required(env.WORKDIR, 'WORKDIR')), 'claude-config'),

    modelId: env.MODEL_ID?.trim() || 'claude-opus-5',
    modelEffort: effort(env.MODEL_EFFORT),
    maxTurns: integer(env.MAX_TURNS, 'MAX_TURNS', 80, 1),

    brokerTimeoutMs: integer(env.BROKER_TIMEOUT_MS, 'BROKER_TIMEOUT_MS', 10_000, 1),
    orchestratorTimeoutMs: integer(
      env.ORCHESTRATOR_TIMEOUT_MS,
      'ORCHESTRATOR_TIMEOUT_MS',
      10_000,
      1,
    ),
    shutdownStatusTimeoutMs: integer(
      env.SHUTDOWN_STATUS_TIMEOUT_MS,
      'SHUTDOWN_STATUS_TIMEOUT_MS',
      2000,
      1,
    ),
    statusRetryLimit: integer(env.STATUS_RETRY_LIMIT, 'STATUS_RETRY_LIMIT', 3, 0),
    statusRetryWindowMs: integer(env.STATUS_RETRY_WINDOW_MS, 'STATUS_RETRY_WINDOW_MS', 30_000, 1),
    shutdownGraceMs: integer(env.SHUTDOWN_GRACE_MS, 'SHUTDOWN_GRACE_MS', 4000, 1),

    commitCadenceWarnAfter: integer(
      env.COMMIT_CADENCE_WARN_AFTER,
      'COMMIT_CADENCE_WARN_AFTER',
      25,
      1,
    ),
    maxConcurrentSubagents: integer(
      env.MAX_CONCURRENT_SUBAGENTS,
      'MAX_CONCURRENT_SUBAGENTS',
      2,
      1,
    ),

    credentials: {
      orchestratorToken: required(env.ORCHESTRATOR_TOKEN, 'ORCHESTRATOR_TOKEN'),
      giteaBotToken: required(env.GITEA_BOT_TOKEN, 'GITEA_BOT_TOKEN'),
      modelApiKey: required(env.MODEL_API_KEY, 'MODEL_API_KEY'),
    },
  };
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function effort(value: string | undefined): ModelEffort {
  const candidate = value?.trim();
  if (candidate === undefined || candidate === '') return 'high';
  if (!(EFFORT_LEVELS as readonly string[]).includes(candidate)) {
    throw new Error(`MODEL_EFFORT must be one of ${EFFORT_LEVELS.join(', ')}, got ${candidate}`);
  }
  return candidate as ModelEffort;
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
