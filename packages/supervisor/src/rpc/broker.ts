import { createHash } from 'node:crypto';
import { chmod, unlink } from 'node:fs/promises';
import net from 'node:net';
import type { Deps } from '../deps.js';
import { handleRpc } from './handlers.js';
import { rpcError, type RpcRequest, type RpcResponse } from './protocol.js';

/**
 * B20: the broker listens on a unix socket. Filesystem permissions are the
 * authorisation, so the plan agent holds no credential pointing at the sandbox
 * and B6's "credential-free toward the sandbox" stays literally true. A
 * localhost port would be reachable by anything in the same network namespace
 * and would need a token of its own — which is exactly what B6 removed.
 */
export interface Broker {
  listen(planId: string, socketPath: string): Promise<void>;
  close(planId: string): Promise<void>;
  closeAll(): Promise<void>;
}

/**
 * Node implements local domain sockets on Windows as named pipes, not AF_UNIX,
 * and will not listen on a filesystem path there. The daemon only ever runs on
 * Linux; this exists so the operator can run the suite on their own machine,
 * which is the same reason B22 gives for the driver seams.
 */
export function listenAddress(socketPath: string): string {
  if (process.platform !== 'win32') return socketPath;
  const digest = createHash('sha256').update(socketPath).digest('hex').slice(0, 24);
  return `\\\\.\\pipe\\mycelium-${digest}`;
}

const MAX_REQUEST_BYTES = 1024 * 1024;

export class UnixSocketBroker implements Broker {
  private readonly servers = new Map<string, net.Server>();
  private readonly paths = new Map<string, string>();

  constructor(private readonly deps: Deps) {}

  async listen(planId: string, socketPath: string): Promise<void> {
    const address = listenAddress(socketPath);

    // A stale socket from a killed supervisor would block the bind, and
    // restart reconciliation may well be re-creating this very environment.
    if (address === socketPath) await unlink(socketPath).catch(() => undefined);

    // The client half-closes to signal end-of-request. Without allowHalfOpen
    // Node would close this side's writable end with it, and the response
    // would have nowhere to go.
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      void this.serve(planId, socket);
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(address, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    // Owner-only. This is the authorisation, so it is not decoration. chmod is
    // a no-op on Windows, where the named pipe's default ACL applies instead.
    if (address === socketPath) await chmod(socketPath, 0o600).catch(() => undefined);

    this.servers.set(planId, server);
    this.paths.set(planId, socketPath);
  }

  async close(planId: string): Promise<void> {
    const server = this.servers.get(planId);
    if (server === undefined) return;

    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.servers.delete(planId);

    const socketPath = this.paths.get(planId);
    this.paths.delete(planId);
    if (socketPath !== undefined && listenAddress(socketPath) === socketPath) {
      await unlink(socketPath).catch(() => undefined);
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.servers.keys()].map((planId) => this.close(planId)));
  }

  /**
   * One request per connection: read to EOF or to a newline, answer, close.
   * The caller is semi-trusted, so the read is capped and a parse failure is an
   * answer rather than an exception that would take the listener down.
   */
  private async serve(planId: string, socket: net.Socket): Promise<void> {
    const chunks: Buffer[] = [];
    let size = 0;
    let answered = false;

    const answer = (response: RpcResponse): void => {
      if (answered) return;
      answered = true;
      socket.end(`${JSON.stringify(response)}\n`);
    };

    socket.on('error', () => socket.destroy());

    // Both the newline and the half-close can arrive; the request is handled
    // once. Guarding only the write would run the method twice — and an
    // events.emit run twice is two events.
    let handled = false;
    const respond = (): void => {
      if (handled) return;
      handled = true;
      void (async () => {
        let request: RpcRequest;
        try {
          request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RpcRequest;
        } catch {
          answer(rpcError('invalid_request', 'the request was not JSON'));
          return;
        }

        try {
          answer(await handleRpc(this.deps, planId, request));
        } catch (error) {
          answer(rpcError('internal_error', (error as Error).message));
        }
      })();
    };

    socket.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        answer(rpcError('request_too_large', 'the request exceeded 1 MiB'));
        socket.destroy();
        return;
      }
      chunks.push(chunk);
      // A newline terminates a request, so an agent that keeps the connection
      // open still gets its answer.
      if (chunk.includes(0x0a)) respond();
    });

    socket.on('end', respond);
  }
}
