import type { EventEnvelope } from '@mycelium/contracts';
import type { Deps } from '../deps.js';
import type { Environment } from '../environments/ledger.js';
import { canLaunchSandbox } from '../domain/admission.js';
import { headTail } from '../domain/truncate.js';
import { rpcError, type RpcRequest, type RpcResponse } from './protocol.js';

/**
 * Everything the plan agent may ask for, and nothing else.
 *
 * The plan id comes from the socket the request arrived on, never from the
 * request body. That is the whole reason the socket is per-plan: an agent
 * cannot name another plan because it has no way to say one.
 */

/** Mirrors the orchestrator's ingest guard. Catching it here keeps a bad event out of the spool. */
const SECRET_KEY = /token|secret|password|api[_-]?key/i;

/** Set by the supervisor for a networked sandbox; an agent that sets them is refused. */
const RESERVED_SANDBOX_ENV = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']);

const EVENT_TYPES = new Set<EventEnvelope['type']>([
  'plan.state_changed',
  'task.state_changed',
  'task.dispatched',
  'task.lease_expired',
  'agent.model_call',
  'agent.tool_call',
  'sandbox.launched',
  'sandbox.exited',
  'limit.exceeded',
  'supervisor.heartbeat',
  'operator.action',
  'egress.allowed',
  'egress.denied',
  'environment.state_changed',
  'error',
]);

export async function handleRpc(
  deps: Deps,
  planId: string,
  request: RpcRequest,
): Promise<RpcResponse> {
  if (typeof request !== 'object' || request === null || typeof request.method !== 'string') {
    return rpcError('invalid_request', 'expected { method, params }');
  }

  const environment = deps.ledger.get(planId);
  if (environment === undefined) {
    return rpcError('no_environment', 'this node is no longer running that plan');
  }

  switch (request.method) {
    case 'events.emit':
      return emitEvent(deps, environment, request.params);
    case 'sandbox.run':
      return runSandbox(deps, environment, request.params);
    default:
      return rpcError('unknown_method', `no such method: ${request.method}`);
  }
}

interface EmitParams {
  type?: string;
  severity?: 'debug' | 'info' | 'warn' | 'error';
  ts?: string;
  task_id?: string | null;
  payload?: Record<string, unknown>;
}

async function emitEvent(
  deps: Deps,
  environment: Environment,
  raw: unknown,
): Promise<RpcResponse> {
  const params = (raw ?? {}) as EmitParams;

  if (typeof params.type !== 'string' || !EVENT_TYPES.has(params.type as EventEnvelope['type'])) {
    return rpcError('invalid_event', `no such event type: ${String(params.type)}`);
  }

  const payload = params.payload;
  if (payload !== undefined && payload !== null) {
    const offending = Object.keys(payload).find((key) => SECRET_KEY.test(key));
    if (offending !== undefined) {
      // The orchestrator refuses the whole batch for this, which would wedge
      // the spool behind one bad record. Cheaper to stop it entering.
      return rpcError('secret_in_payload', `payload key ${offending} looks like a secret`);
    }
  }

  await deps.events.emit({
    source: 'agent',
    type: params.type as EventEnvelope['type'],
    severity: params.severity ?? 'info',
    planId: environment.planId,
    taskId: params.task_id ?? null,
    ...(params.ts === undefined ? {} : { ts: params.ts }),
    payload: payload ?? {},
  });

  return { ok: true, result: { recorded: true } };
}

interface RunParams {
  image?: string;
  cmd?: string[];
  env?: Record<string, string>;
  network?: boolean;
  limits?: { cpus?: number; memory_mb?: number; timeout_sec?: number };
}

async function runSandbox(
  deps: Deps,
  environment: Environment,
  raw: unknown,
): Promise<RpcResponse> {
  const params = (raw ?? {}) as RunParams;

  if (typeof params.image !== 'string' || !Array.isArray(params.cmd) || params.cmd.length === 0) {
    return rpcError('invalid_params', 'image and a non-empty cmd are required');
  }

  // Validated here rather than agent-side: the agent is semi-trusted, so an
  // allowlist it could edit would not be one.
  if (!deps.config.sandboxImages.includes(params.image)) {
    return rpcError('image_not_allowed', `${params.image} is not on this node's image allowlist`);
  }

  const env = params.env ?? {};
  for (const key of Object.keys(env)) {
    if (RESERVED_SANDBOX_ENV.has(key)) {
      return rpcError('reserved_sandbox_env', `${key} is set by the supervisor, not the agent`);
    }
    // Sandboxes receive no credentials, ever (baseline section 7, G3).
    if (SECRET_KEY.test(key)) {
      return rpcError('credential_in_sandbox_env', `${key} looks like a credential`);
    }
  }

  if (!canLaunchSandbox(environment.sandboxes.size, deps.config.maxSandboxesPerEnvironment)) {
    return rpcError(
      'capacity_exceeded',
      `this plan already has ${environment.sandboxes.size} sandboxes running`,
    );
  }

  const networked = params.network === true;
  const spec = {
    planId: environment.planId,
    image: params.image,
    cmd: params.cmd,
    env: {
      ...env,
      // The sandbox has no route out and no resolver, so this is not a
      // preference: without it a networked container reaches nothing.
      ...(networked
        ? {
            HTTP_PROXY: environment.proxyUrl,
            HTTPS_PROXY: environment.proxyUrl,
            NO_PROXY: '',
          }
        : {}),
    },
    workdir: '/workspace',
    network: networked ? environment.network : null,
    // The agent may ask for less but never for more. Caps are the VM's, not
    // the plan's, and a runaway container must not starve the agent beside it.
    cpus: Math.min(params.limits?.cpus ?? deps.config.sandboxCpus, deps.config.sandboxCpus),
    memoryMb: Math.min(
      params.limits?.memory_mb ?? deps.config.sandboxMemoryMb,
      deps.config.sandboxMemoryMb,
    ),
    timeoutSec: Math.min(
      params.limits?.timeout_sec ?? deps.config.sandboxTimeoutSec,
      deps.config.sandboxTimeoutCeilingSec,
    ),
    // It receives the working directory and nothing else (baseline section 4).
    mounts: [{ source: environment.workdir, target: '/workspace', readonly: false }],
  };

  let containerId: string | null = null;

  try {
    const result = await deps.containers.run(spec, (id) => {
      containerId = id;
      environment.sandboxes.add(id);
      void deps.events.emit({
        source: 'supervisor',
        type: 'sandbox.launched',
        planId: environment.planId,
        payload: { container_id: id, image: spec.image, network: networked },
      });
    });

    environment.sandboxes.delete(result.containerId);

    const caps = { headBytes: deps.config.outputHeadBytes, tailBytes: deps.config.outputTailBytes };
    const stdout = headTail(result.stdout, caps);
    const stderr = headTail(result.stderr, caps);

    await deps.events.emit({
      source: 'supervisor',
      type: 'sandbox.exited',
      planId: environment.planId,
      payload: {
        container_id: result.containerId,
        exit_code: result.exitCode,
        timed_out: result.timedOut,
        stdout_bytes: stdout.bytes,
        stderr_bytes: stderr.bytes,
      },
    });

    return {
      ok: true,
      result: {
        container_id: result.containerId,
        exit_code: result.exitCode,
        timed_out: result.timedOut,
        stdout,
        stderr,
      },
    };
  } catch (error) {
    if (containerId !== null) environment.sandboxes.delete(containerId);
    await deps.events.emit({
      source: 'supervisor',
      type: 'error',
      severity: 'error',
      planId: environment.planId,
      payload: { stage: 'sandbox_run', message: (error as Error).message },
    });
    return rpcError('sandbox_failed', (error as Error).message);
  }
}
