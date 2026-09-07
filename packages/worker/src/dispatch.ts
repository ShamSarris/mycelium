import { chmod, unlink } from 'node:fs/promises';
import net from 'node:net';
import type { Deps } from './deps.js';
import { rpcError, type PingResult, type RpcRequest, type RpcResponse, type TaskDispatch } from './protocol.js';
import { MAX_REQUEST_BYTES, socketAddress } from './socket.js';

/**
 * This agent's listener: the direction a server cannot push (ticket 0003
 * gap 9). The supervisor dials it to hand over a task, and restart
 * re-attachment dials it to ask whether anything here is still alive.
 *
 * One task at a time. `max_concurrent_agents` is carried and reported but
 * unused until sub-agents exist, and refusing loudly is the right answer
 * meanwhile: the supervisor turns a refusal into a 409 and the orchestrator
 * returns the task to `ready` immediately, where accepting quietly would cost
 * it the whole lease before anything happened.
 */

export type TaskRunner = (dispatch: TaskDispatch) => Promise<void>;

export class DispatchServer {
  private server: net.Server | null = null;
  private inFlight: { dispatch: TaskDispatch; done: Promise<void> } | null = null;
  private closing = false;

  constructor(
    private readonly deps: Deps,
    private readonly run: TaskRunner,
  ) {}

  get busy(): boolean {
    return this.inFlight !== null;
  }

  get currentTaskId(): string | null {
    return this.inFlight?.dispatch.task_id ?? null;
  }

  /** Resolves when nothing is in flight. Tests wait on it; shutdown does too. */
  async idle(): Promise<void> {
    await this.inFlight?.done;
  }

  async listen(): Promise<void> {
    const path = this.deps.config.dispatchSocket;
    const address = socketAddress(path);

    // A stale socket from a killed agent would block the bind, and the
    // supervisor may well be re-provisioning this very plan.
    if (address === path) await unlink(path).catch(() => undefined);

    // The caller half-closes to signal end-of-request. Without allowHalfOpen
    // Node would close this side's writable end with it, and the answer would
    // have nowhere to go.
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      this.serve(socket);
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(address, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    // Owner-only. Filesystem permissions are the authorisation on this pair of
    // sockets, so this is not decoration. chmod is a no-op on Windows, where
    // the named pipe's default ACL applies instead.
    if (address === path) await chmod(path, 0o600).catch(() => undefined);

    this.server = server;
  }

  async close(): Promise<void> {
    this.closing = true;
    const server = this.server;
    this.server = null;
    if (server === null) return;

    await new Promise<void>((resolve) => server.close(() => resolve()));

    const path = this.deps.config.dispatchSocket;
    if (socketAddress(path) === path) await unlink(path).catch(() => undefined);
  }

  /**
   * One request per connection: read to a newline or to EOF, answer, close.
   * The caller is the supervisor, which is trusted — but the read is still
   * capped and a parse failure is still an answer rather than an exception,
   * because a listener that dies on a bad frame takes the plan with it.
   */
  private serve(socket: net.Socket): void {
    const chunks: Buffer[] = [];
    let size = 0;
    let answered = false;
    let handled = false;

    const answer = (response: RpcResponse): void => {
      if (answered) return;
      answered = true;
      socket.end(`${JSON.stringify(response)}\n`);
    };

    socket.on('error', () => socket.destroy());

    // Both the newline and the half-close can arrive; the request is handled
    // once. Guarding only the write would start the task twice.
    const respond = (): void => {
      if (handled) return;
      handled = true;

      let request: RpcRequest;
      try {
        request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RpcRequest;
      } catch {
        answer(rpcError('invalid_request', 'the request was not JSON'));
        return;
      }

      answer(this.handle(request));
    };

    socket.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        answer(rpcError('request_too_large', 'the request exceeded 1 MiB'));
        socket.destroy();
        return;
      }
      chunks.push(chunk);
      if (chunk.includes(0x0a)) respond();
    });

    socket.on('end', respond);
  }

  /** Synchronous on purpose: every answer is decided before the task starts. */
  private handle(request: RpcRequest): RpcResponse {
    if (typeof request !== 'object' || request === null || typeof request.method !== 'string') {
      return rpcError('invalid_request', 'expected { method, params }');
    }

    switch (request.method) {
      case 'agent.ping':
        return { ok: true, result: this.ping() };
      case 'task.dispatch':
        return this.dispatch(request.params);
      default:
        return rpcError('unknown_method', `no such method: ${request.method}`);
    }
  }

  private ping(): PingResult {
    return {
      plan_id: this.deps.config.planId,
      ready: !this.closing && this.server !== null && this.inFlight === null,
      task_id: this.currentTaskId,
    };
  }

  private dispatch(raw: unknown): RpcResponse {
    const dispatch = parseDispatch(raw);
    if (dispatch === null) {
      return rpcError('invalid_params', 'that is not a task dispatch');
    }

    // The socket is per-plan, so this can only ever be a routing bug on the
    // other side. Refuse it rather than run someone else's task.
    if (dispatch.plan_id !== this.deps.config.planId) {
      return rpcError('wrong_plan', 'this agent is not running that plan');
    }

    if (this.closing || this.inFlight !== null) {
      return { ok: true, result: { accepted: false } };
    }

    // Started, not awaited: the answer goes back now and the task runs on.
    const done = this.run(dispatch)
      .catch((error: unknown) => {
        // The loop reports its own failures. Anything reaching here escaped
        // that, and the only thing that must not happen is a wedged agent
        // that refuses every later task.
        this.deps.log?.warn?.({ err: error, taskId: dispatch.task_id }, 'the task loop threw');
      })
      .finally(() => {
        this.inFlight = null;
      });

    this.inFlight = { dispatch, done };
    return { ok: true, result: { accepted: true } };
  }
}

function parseDispatch(raw: unknown): TaskDispatch | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as Record<string, unknown>;

  const limits = candidate.limits as Record<string, unknown> | undefined;

  if (
    typeof candidate.plan_id !== 'string' ||
    typeof candidate.task_id !== 'string' ||
    typeof candidate.local_id !== 'string' ||
    typeof candidate.dispatch_id !== 'string' ||
    typeof candidate.description !== 'string' ||
    typeof candidate.execution_attempt !== 'number' ||
    typeof candidate.cost_spent_so_far_microusd !== 'number' ||
    typeof limits !== 'object' ||
    limits === null ||
    typeof limits.cost_microusd !== 'number' ||
    typeof limits.wall_clock_min !== 'number'
  ) {
    return null;
  }

  return candidate as unknown as TaskDispatch;
}
