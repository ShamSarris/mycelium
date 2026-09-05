import net from 'node:net';
import { socketAddress } from '../../src/socket.js';

/**
 * A stand-in for the supervisor's broker socket, speaking exactly the protocol
 * [rpc/broker.ts] speaks: one request per connection, read to a newline or a
 * half-close, answer, close. Tests drive the real client against this rather
 * than against a mocked `net`, because the framing is the part worth testing.
 */
export interface StubBroker {
  /** Every request that arrived, parsed. */
  readonly requests: unknown[];
  /** How many connections were opened. One per call, or the client is wrong. */
  readonly connections: number;
  /** Answer the next request with this. Defaults to `{ok: true, result: {}}`. */
  respond: (request: { method: string; params?: unknown }) => unknown;
  /** Accept the connection and never answer, so the client must time out. */
  silent: boolean;
  close(): Promise<void>;
}

export async function startStubBroker(socketPath: string): Promise<StubBroker> {
  const requests: unknown[] = [];
  const open = new Set<net.Socket>();
  let connections = 0;

  const stub = {
    requests,
    get connections() {
      return connections;
    },
    respond: () => ({ ok: true, result: {} }),
    silent: false,
    close: async () => {
      // `server.close` waits for open connections, and the silent mode exists
      // precisely to leave one open. Destroy them first or the helper hangs.
      for (const socket of open) socket.destroy();
      open.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  } as StubBroker;

  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    connections += 1;
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    const chunks: Buffer[] = [];
    let handled = false;

    const respond = (): void => {
      if (handled) return;
      handled = true;
      let request: { method: string; params?: unknown };
      try {
        request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        socket.end(`${JSON.stringify({ ok: false, error: { code: 'invalid_request', message: 'not JSON' } })}\n`);
        return;
      }
      requests.push(request);
      if (stub.silent) return;
      socket.end(`${JSON.stringify(stub.respond(request))}\n`);
    };

    socket.on('error', () => socket.destroy());
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      if (chunk.includes(0x0a)) respond();
    });
    socket.on('end', respond);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketAddress(socketPath), () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  return stub;
}
