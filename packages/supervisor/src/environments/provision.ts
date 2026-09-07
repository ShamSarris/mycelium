import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Deps } from '../deps.js';
import { HttpError } from '../errors.js';
import { CloneError } from '../drivers/git.js';
import { writeRecord } from './record.js';
import { canAdmit } from '../domain/admission.js';
import { isEgressRule } from '../domain/egress.js';
import { deriveMaxConcurrentSubagents } from '../domain/concurrency.js';

/**
 * What the orchestrator sends on `POST /plans`. Mirrors `PlanDispatch` in the
 * orchestrator's supervisor client; that side is already shipped and tested, so
 * this shape is fixed.
 */
export interface PlanDispatch {
  plan_id: string;
  project: { id: string; name: string };
  gitea: { repo_url: string; branch: string; bot_token: string };
  orchestrator_token: string;
  egress: string[];
  max_concurrent_agents: number;
  env_ttl_min: number;
}

export function planRoot(deps: Deps, planId: string): string {
  return path.join(deps.config.stateDir, 'plans', planId);
}

/**
 * Admission and provisioning. The reply goes out only once the agent is up:
 * the orchestrator marks the plan `running` on this response and starts
 * dispatching tasks immediately, so an early acceptance races the agent's own
 * startup.
 */
export async function dispatchPlan(deps: Deps, body: unknown): Promise<{ accepted: true }> {
  const dispatch = validate(body);

  // Sticky placement makes the plan id a sufficient idempotency key; the
  // dispatch carries no dispatch_id of its own.
  if (deps.ledger.has(dispatch.plan_id)) return { accepted: true };

  if (!canAdmit(deps.ledger.size, deps.config.maxEnvironments)) {
    throw HttpError.capacityExceeded(
      `this node is running ${deps.ledger.size} of ${deps.config.maxEnvironments} environments`,
    );
  }

  await provision(deps, dispatch);
  return { accepted: true };
}

async function provision(deps: Deps, dispatch: PlanDispatch): Promise<void> {
  const planId = dispatch.plan_id;
  const root = planRoot(deps, planId);
  const workdir = path.join(root, 'repo');
  const runDir = path.join(root, 'run');

  let network: string | null = null;
  let brokerListening = false;
  let proxyListening = false;

  const claudeConfigDir = path.join(runDir, '.claude');

  try {
    await mkdir(runDir, { recursive: true });
    await mkdir(workdir, { recursive: true });
    // Ticket 15: HOME and CLAUDE_CONFIG_DIR must exist before the agent SDK's
    // `claude` subprocess starts — not assumed to be created lazily. Nested
    // under runDir/root, so teardown's `rm(root, { recursive: true })`
    // removes it with everything else; nothing extra to clean up.
    await mkdir(claudeConfigDir, { recursive: true });

    // The bot token ends up in .git/config inside the environment. Accepted:
    // the agent holds the same token by design, and the tree is scrubbed at
    // teardown (ticket 0003 section 13).
    await deps.git.clone({
      repoUrl: dispatch.gitea.repo_url,
      branch: dispatch.gitea.branch,
      token: dispatch.gitea.bot_token,
      dir: workdir,
    });

    const created = await deps.containers.createNetwork(planId);
    network = created.name;

    // Bound to this plan's own gateway, so the plan a request belongs to is
    // decided by which socket it arrived on rather than anything the sandbox
    // could write into a header.
    const proxy = await deps.proxy.listen(planId, created.gatewayAddress);
    proxyListening = true;

    const brokerSocket = path.join(runDir, 'broker.sock');
    const dispatchSocket = path.join(runDir, 'dispatch.sock');

    // Listening before the agent starts, so its first call cannot race the
    // socket into existence.
    await deps.broker.listen(planId, brokerSocket);
    brokerListening = true;

    // Deliberate injection, not inheritance. B13's guarantee is that the
    // supervisor's own environment holds no secrets for a child to inherit;
    // handing the agent exactly what its plan needs is a different act.
    const agent = await deps.agents.start({
      planId,
      cwd: workdir,
      brokerSocket,
      dispatchSocket,
      env: {
        PLAN_ID: planId,
        PROJECT_ID: dispatch.project.id,
        PROJECT_NAME: dispatch.project.name,
        ORCHESTRATOR_URL: deps.config.orchestratorUrl,
        ORCHESTRATOR_TOKEN: dispatch.orchestrator_token,
        GITEA_BOT_TOKEN: dispatch.gitea.bot_token,
        GITEA_BRANCH: dispatch.gitea.branch,
        MODEL_API_KEY: deps.secret('model_api_key'),
        AGENT_SOCKET: brokerSocket,
        DISPATCH_SOCKET: dispatchSocket,
        WORKDIR: workdir,
        // Isolated per plan, inside runDir, so nothing is shared between
        // plans and teardown removes both with the rest of the environment.
        HOME: runDir,
        CLAUDE_CONFIG_DIR: claudeConfigDir,
        // Ticket 13: the operator-authored plan cannot know what this VM can
        // take; the supervisor derives it from its own memory ceiling on the
        // plan's scope instead. MAX_CONCURRENT_AGENTS no longer exists.
        MAX_CONCURRENT_SUBAGENTS: String(
          deriveMaxConcurrentSubagents(deps.config.agentMemoryMaxBytes),
        ),
      },
    });

    deps.ledger.add({
      planId,
      state: 'running',
      root,
      workdir,
      agent,
      network: created.name,
      proxyUrl: proxy.url,
      brokerSocket,
      // Resolved once, here, so the proxy never has to consult configuration
      // and a plan's list cannot be widened after it was approved (B14).
      egress: [...deps.config.standingEgress, ...dispatch.egress.map((e) => e.toLowerCase())],
      ttlExpiresAt: new Date(deps.clock.now().getTime() + dispatch.env_ttl_min * 60_000),
      sandboxes: new Set(),
    });

    // Written last, once the environment is genuinely up. Discovery after a
    // restart starts from these records, so one that exists for a half-built
    // environment would adopt a plan into something that never finished.
    await writeRecord({
      plan_id: planId,
      root,
      workdir,
      network: created.name,
      gateway_address: created.gatewayAddress,
      broker_socket: brokerSocket,
      dispatch_socket: dispatchSocket,
      egress: deps.ledger.get(planId)?.egress ?? [],
      ttl_expires_at: (deps.ledger.get(planId)?.ttlExpiresAt ?? deps.clock.now()).toISOString(),
    });

    await deps.events.emit({
      source: 'supervisor',
      type: 'environment.state_changed',
      planId,
      projectId: dispatch.project.id,
      payload: { from: 'provisioning', to: 'running', reason: 'dispatched' },
    });
  } catch (error) {
    await unwind(deps, planId, root, network, brokerListening, proxyListening, error);
    throw asDispatchError(error);
  }
}

/**
 * A half-built environment is worse than none: it holds capacity, leaves a
 * directory a retry would trip over, and keeps a network alive. Everything here
 * tolerates its object never having existed.
 */
async function unwind(
  deps: Deps,
  planId: string,
  root: string,
  network: string | null,
  brokerListening: boolean,
  proxyListening: boolean,
  cause: unknown,
): Promise<void> {
  deps.ledger.remove(planId);

  if (brokerListening) {
    await deps.broker.close(planId).catch(() => undefined);
  }
  if (proxyListening) {
    await deps.proxy.close(planId).catch(() => undefined);
  }

  if (network !== null) {
    await deps.containers.removeNetwork(network).catch(() => undefined);
  }
  await rm(root, { recursive: true, force: true }).catch(() => undefined);

  await deps.events.emit({
    source: 'supervisor',
    type: 'environment.state_changed',
    severity: 'warn',
    planId,
    payload: {
      from: 'provisioning',
      to: 'failed',
      reason: cause instanceof CloneError ? cause.reason : 'provisioning_failed',
      message: (cause as Error).message,
    },
  });
}

/**
 * The distinction the orchestrator acts on. A terminal rejection fails the plan
 * with a manifest naming the reason; a retryable one sends it to the next
 * candidate, which is what makes first-fit a failover mechanism (B12).
 */
function asDispatchError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;

  if (error instanceof CloneError && error.reason !== 'transient') {
    return HttpError.validationFailed(`cannot check out the plan branch: ${error.message}`);
  }

  return HttpError.capacityExceeded(`this node could not provision: ${(error as Error).message}`);
}

function validate(body: unknown): PlanDispatch {
  if (typeof body !== 'object' || body === null) {
    throw HttpError.validationFailed('the dispatch body must be an object');
  }
  const dispatch = body as Partial<PlanDispatch>;

  requireString(dispatch.plan_id, 'plan_id');
  requireString(dispatch.orchestrator_token, 'orchestrator_token');
  requireString(dispatch.project?.id, 'project.id');
  requireString(dispatch.project?.name, 'project.name');
  requireString(dispatch.gitea?.repo_url, 'gitea.repo_url');
  requireString(dispatch.gitea?.branch, 'gitea.branch');
  requireString(dispatch.gitea?.bot_token, 'gitea.bot_token');

  if (!Array.isArray(dispatch.egress)) {
    throw HttpError.validationFailed('egress must be an array, empty for default deny');
  }
  for (const rule of dispatch.egress) {
    // The orchestrator validated these against the plan schema already. Doing
    // it again here is cheap, and this is the process that enforces them.
    if (typeof rule !== 'string' || !isEgressRule(rule)) {
      throw HttpError.validationFailed(`egress entry ${JSON.stringify(rule)} is not a hostname`);
    }
  }

  const concurrency = dispatch.max_concurrent_agents;
  if (!Number.isInteger(concurrency) || concurrency === undefined || concurrency < 1 || concurrency > 4) {
    throw HttpError.validationFailed('max_concurrent_agents must be an integer between 1 and 4');
  }

  const ttl = dispatch.env_ttl_min;
  if (!Number.isInteger(ttl) || ttl === undefined || ttl < 1) {
    throw HttpError.validationFailed('env_ttl_min must be a positive integer');
  }

  return dispatch as PlanDispatch;
}

function requireString(value: unknown, field: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw HttpError.validationFailed(`${field} is required`);
  }
}
