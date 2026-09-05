import { createHash } from 'node:crypto';

/**
 * Node implements local domain sockets on Windows as named pipes, not AF_UNIX,
 * and will not listen on or connect to a filesystem path there. The agent only
 * ever runs on Linux; this exists so the operator can run the suite on their
 * own machine. Deliberately identical to the supervisor's [rpc/broker.ts]
 * shim — the two must agree on the mapping or they would miss each other on a
 * developer machine.
 */
export function socketAddress(socketPath: string): string {
  if (process.platform !== 'win32') return socketPath;
  const digest = createHash('sha256').update(socketPath).digest('hex').slice(0, 24);
  return `\\\\.\\pipe\\mycelium-${digest}`;
}

/** The supervisor's cap, matched: a semi-trusted peer does not get to send unbounded frames. */
export const MAX_REQUEST_BYTES = 1024 * 1024;
