import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import type { Deps } from '../deps.js';
import { matchEgress, portAllowed } from '../domain/egress.js';

/**
 * B14 made real. Until this existed, `egress[]` was carried through the whole
 * system and enforced by nothing.
 *
 * A sandbox sits on an internal network with no route out and no resolver, so
 * this proxy is its only path anywhere. It permits the standing set plus the
 * hostnames the plan declared — which were shown to the operator at the
 * approval gate and cannot widen afterwards — and refuses everything else.
 * Because the proxy resolves the name, the sandbox has no DNS side channel.
 *
 * There is deliberately no unrestricted mode and no configuration flag that
 * creates one. A plan that needs more declares more and goes back through the
 * gate.
 */

export const DEFAULT_PROXY_PORT = 3128;

/** The outbound connection, injectable so tests need no DNS. */
export type Connector = (host: string, port: number) => Duplex;

export interface ProxyListener {
  listen(planId: string, host: string, port?: number): Promise<{ url: string; port: number }>;
  close(planId: string): Promise<void>;
  closeAll(): Promise<void>;
}

/**
 * One listener per plan, bound to that plan's own network gateway. The plan is
 * therefore identified by which socket the request arrived on — never by a
 * header, which the thing on the other end could write.
 */
export class EgressProxy implements ProxyListener {
  private readonly servers = new Map<string, http.Server>();

  constructor(
    private readonly deps: Deps,
    private readonly connect: Connector = (host, port) => net.connect(port, host),
  ) {}

  async listen(
    planId: string,
    host: string,
    port: number = DEFAULT_PROXY_PORT,
  ): Promise<{ url: string; port: number }> {
    const server = http.createServer((_request, response) => {
      // CONNECT only. A plain proxied request would let the sandbox send a
      // body this process would have to read, and there is no reason to.
      response.writeHead(405, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: 'connect_only' }));
    });

    server.on('connect', (request, socket, head) => {
      void this.tunnel(planId, request, socket, head);
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    const address = server.address() as net.AddressInfo;
    this.servers.set(planId, server);
    return { url: `http://${host}:${address.port}`, port: address.port };
  }

  async close(planId: string): Promise<void> {
    const server = this.servers.get(planId);
    if (server === undefined) return;
    this.servers.delete(planId);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.servers.keys()].map((planId) => this.close(planId)));
  }

  private async tunnel(
    planId: string,
    request: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    socket.on('error', () => socket.destroy());

    const environment = this.deps.ledger.get(planId);
    if (environment === undefined) {
      return this.refuse(socket, planId, request.url ?? '', null, 'no_environment');
    }

    const { host, port } = parseAuthority(request.url ?? '');

    if (host === null || port === null || !portAllowed(port)) {
      return this.refuse(socket, planId, request.url ?? '', port, 'port_not_allowed');
    }

    const rule = matchEgress(host, environment.egress);
    if (rule === null) {
      return this.refuse(socket, planId, host, port, 'not_allowlisted');
    }

    let upstream: Duplex;
    try {
      upstream = this.connect(host, port);
    } catch (error) {
      return this.refuse(socket, planId, host, port, (error as Error).message);
    }

    upstream.on('error', () => {
      socket.destroy();
      upstream.destroy();
    });

    await this.deps.events.emit({
      source: 'supervisor',
      type: 'egress.allowed',
      planId,
      // The host, the port, and the rule that permitted it. Never a URL path,
      // a header, or a byte of the body.
      payload: { host, port, rule },
    });

    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  }

  private async refuse(
    socket: Duplex,
    planId: string,
    host: string,
    port: number | null,
    reason: string,
  ): Promise<void> {
    await this.deps.events.emit({
      source: 'supervisor',
      type: 'egress.denied',
      severity: 'warn',
      planId,
      payload: { host, port, rule: null, reason },
    });

    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.end();
  }
}

/** A CONNECT target is `host:port` and nothing else — no scheme, no path. */
function parseAuthority(authority: string): { host: string | null; port: number | null } {
  const separator = authority.lastIndexOf(':');
  if (separator <= 0) return { host: null, port: null };

  const host = authority.slice(0, separator);
  const port = Number.parseInt(authority.slice(separator + 1), 10);
  if (!Number.isInteger(port)) return { host: null, port: null };

  return { host, port };
}
