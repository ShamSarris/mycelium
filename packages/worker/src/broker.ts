import net from 'node:net';
import type { AgentEventType } from './events.js';
import type { RpcRequest, RpcResponse } from './protocol.js';
import { MAX_REQUEST_BYTES, socketAddress } from './socket.js';

/**
 * The supervisor as this agent sees it: somewhere to send events and somewhere
 * to ask for a sandbox. One connection per call, closed after the response.
 *
 * Neither call is ever fatal to this process. A failed emit is logged and
 * dropped — the supervisor owns the durable spool, and an agent that buffered
 * would be the agent-side buffering archive T3 forbids. A failed `sandboxRun`
 * becomes a tool result the model can react to.
 */
export interface BrokerClient {
  emit(event: AgentEvent): Promise<void>;
  sandboxRun(params: SandboxRunParams): Promise<SandboxResult>;
}

/**
 * What the agent may say about an event, and no more. The supervisor stamps
 * `event_id`, `source`, `stream_id`, `seq`, and the plan id — the plan comes
 * from the socket the request arrived on, never from anything sent.
 */
export interface AgentEvent {
  type: AgentEventType;
  severity?: 'debug' | 'info' | 'warn' | 'error';
  taskId?: string | null;
  payload?: Record<string, unknown>;
}

export interface SandboxRunParams {
  image: string;
  cmd: string[];
  env?: Record<string, string>;
  network?: boolean;
  limits?: { cpus?: number; memory_mb?: number; timeout_sec?: number };
}

/**
 * The broker's `sandbox.run` result. `stdout` and `stderr` arrive already
 * bounded by the supervisor's head/tail caps, which is why each carries the
 * byte count it was cut from.
 */
export interface SandboxResult {
  container_id: string;
  exit_code: number;
  timed_out: boolean;
  stdout: BoundedOutput;
  stderr: BoundedOutput;
}

/** The supervisor's `BoundedOutput`, verbatim: head, marker, tail. */
export interface BoundedOutput {
  preview: string;
  /** Bytes observed, which is how the agent knows it lost something. */
  bytes: number;
  truncated: boolean;
}

/** A structured refusal from the broker, distinguishable from a transport failure. */
export class BrokerRejection extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BrokerRejection';
  }
}

/**
 * The real client. One connection per call — connect, write the request, half
 * close, read the answer, done. The supervisor's server reads to a newline or
 * a half-close, so both are sent and either would do.
 *
 * The asymmetry between the two methods is deliberate and is the whole point
 * of this class. `emit` cannot fail: the supervisor owns the durable spool, so
 * a dropped event is a lost record, while a thrown one would be a dead agent.
 * `sandboxRun` must fail, and always in the same shape, because the tool layer
 * turns every failure into a tool result the model can react to — a raw socket
 * error there would reach the model as an exception instead.
 */
export class SocketBrokerClient implements BrokerClient {
  constructor(
    private readonly socketPath: string,
    private readonly timeoutMs: number,
    private readonly log?: { warn?: (context: unknown, message: string) => void },
  ) {}

  async emit(event: AgentEvent): Promise<void> {
    try {
      const response = await this.call({
        method: 'events.emit',
        params: {
          type: event.type,
          severity: event.severity ?? 'info',
          task_id: event.taskId ?? null,
          payload: event.payload ?? {},
        },
      });

      if (!response.ok) {
        // A refused event is an emitter bug in this process, not a transient.
        // Retrying would loop; the useful thing is a log line the operator can
        // find next to the events that did land.
        this.log?.warn?.({ code: response.error.code, type: event.type }, 'the supervisor refused an event');
      }
    } catch (error) {
      this.log?.warn?.({ err: error, type: event.type }, 'could not emit an event; dropping it');
    }
  }

  async sandboxRun(params: SandboxRunParams): Promise<SandboxResult> {
    let response: RpcResponse;
    try {
      response = await this.call({ method: 'sandbox.run', params });
    } catch (error) {
      throw new BrokerRejection('broker_unreachable', (error as Error).message);
    }

    // The envelope is checked before it is read as one. A broker answering
    // with an unrecognised shape is a bug worth naming; treating it as a
    // refusal would read `error` off something that has none.
    if (
      typeof response !== 'object' ||
      response === null ||
      typeof (response as { ok?: unknown }).ok !== 'boolean'
    ) {
      throw new BrokerRejection('invalid_result', 'the broker answered with a malformed envelope');
    }

    if (!response.ok) {
      throw new BrokerRejection(response.error.code, response.error.message);
    }

    const result = response.result as SandboxResult | undefined;
    if (result === undefined || result === null || typeof result.container_id !== 'string') {
      throw new BrokerRejection('invalid_result', 'the broker returned something that is not a sandbox result');
    }

    return result;
  }

  private call(request: RpcRequest): Promise<RpcResponse> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;

      const socket = net.createConnection(socketAddress(this.socketPath), () => {
        socket.end(`${JSON.stringify(request)}
`);
      });

      const finish = (error: Error | null, response?: RpcResponse): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error !== null) reject(error);
        else resolve(response as RpcResponse);
      };

      socket.setTimeout(this.timeoutMs, () => {
        finish(new Error(`the broker did not answer within ${this.timeoutMs}ms`));
      });

      socket.on('error', (error) => finish(error));

      socket.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_REQUEST_BYTES) {
          finish(new Error('the broker answered with more than 1 MiB'));
          return;
        }
        chunks.push(chunk);
      });

      socket.on('end', () => {
        try {
          finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8')) as RpcResponse);
        } catch {
          finish(new Error('the broker answered with something that was not JSON'));
        }
      });

      socket.on('close', () => {
        finish(new Error('the broker closed the connection without answering'));
      });
    });
  }
}
