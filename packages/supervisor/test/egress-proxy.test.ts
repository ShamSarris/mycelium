import net from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EgressProxy } from '../src/proxy/connect.js';
import { buildTestApp, type TestHarness } from './helpers/app.js';

let h: TestHarness;
let proxy: EgressProxy;
let proxyPort: number;
let origin: net.Server;
let originPort: number;
let attempted: Array<{ host: string; port: number }>;

const PLAN_ID = '018f3a5c-0000-7000-8000-00000000000a';

beforeAll(async () => {
  h = await buildTestApp();

  // Stands in for whatever the sandbox was trying to reach.
  origin = net.createServer((socket) => {
    socket.on('data', () => socket.end('pong'));
  });
  await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', () => resolve()));
  originPort = (origin.address() as net.AddressInfo).port;
});

afterAll(async () => {
  await h.close();
  await new Promise<void>((resolve) => origin.close(() => resolve()));
});

beforeEach(async () => {
  h.reset();
  h.provisionEnvironment(PLAN_ID, { egress: [...h.config.standingEgress, 'api.github.com', '*.example.com'] });

  attempted = [];
  // The outbound connection is injected so the policy can be tested without
  // DNS or a real internet route.
  proxy = new EgressProxy(h.deps, (host, port) => {
    attempted.push({ host, port });
    return net.connect(originPort, '127.0.0.1');
  });
  const listener = await proxy.listen(PLAN_ID, '127.0.0.1', 0);
  proxyPort = listener.port;
});

afterEach(async () => {
  await proxy.closeAll();
});

interface ConnectOutcome {
  status: number;
  body: string;
}

/** Speaks just enough of the CONNECT dance to see whether it was allowed. */
function connectThrough(authority: string, port = proxyPort): Promise<ConnectOutcome> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(port, '127.0.0.1', () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });

    let buffer = '';
    let established = false;

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (!established && buffer.includes('\r\n\r\n')) {
        const status = Number.parseInt(buffer.split(' ')[1] ?? '0', 10);
        if (status !== 200) {
          socket.destroy();
          resolve({ status, body: buffer });
          return;
        }
        established = true;
        buffer = '';
        socket.write('ping');
      } else if (established) {
        socket.destroy();
        resolve({ status: 200, body: buffer });
      }
    });

    socket.on('error', reject);
    socket.setTimeout(3000, () => {
      socket.destroy();
      reject(new Error('timed out'));
    });
  });
}

describe('the proxy allows what the plan declared', () => {
  it('tunnels to an allowlisted host', async () => {
    const outcome = await connectThrough(`api.github.com:443`);

    expect(outcome.status).toBe(200);
    expect(outcome.body).toBe('pong');
    expect(attempted).toEqual([{ host: 'api.github.com', port: 443 }]);
  });

  it('records the rule that permitted it', async () => {
    await connectThrough('api.github.com:443');

    const [event] = h.events.ofType('egress.allowed');
    expect(event?.planId).toBe(PLAN_ID);
    expect(event?.payload).toEqual({ host: 'api.github.com', port: 443, rule: 'api.github.com' });
  });

  it('allows a subdomain under a wildcard the plan declared', async () => {
    const outcome = await connectThrough('cdn.example.com:443');

    expect(outcome.status).toBe(200);
    expect(h.events.ofType('egress.allowed')[0]?.payload).toMatchObject({
      rule: '*.example.com',
    });
  });

  it('allows a standing-set host the plan never mentioned', async () => {
    const outcome = await connectThrough('registry.npmjs.org:443');
    expect(outcome.status).toBe(200);
  });

  it('allows port 80 as well as 443', async () => {
    expect((await connectThrough('api.github.com:80')).status).toBe(200);
  });
});

describe('the proxy denies everything else (default deny)', () => {
  it('refuses a host outside the list', async () => {
    const outcome = await connectThrough('evil.example.test:443');

    expect(outcome.status).toBe(403);
    expect(attempted).toHaveLength(0);
  });

  it('records the denial with no rule', async () => {
    await connectThrough('evil.example.test:443');

    const [event] = h.events.ofType('egress.denied');
    expect(event?.payload).toMatchObject({ host: 'evil.example.test', port: 443, rule: null });
    expect(event?.severity).toBe('warn');
  });

  it('refuses the apex of a wildcard the plan declared', async () => {
    expect((await connectThrough('example.com:443')).status).toBe(403);
  });

  it('refuses a port outside 80 and 443', async () => {
    expect((await connectThrough('api.github.com:22')).status).toBe(403);
    expect(attempted).toHaveLength(0);
  });

  // An address would walk straight past a list of names.
  it('refuses an IP literal even when it would resolve to an allowed host', async () => {
    expect((await connectThrough('93.184.216.34:443')).status).toBe(403);
  });

  it('refuses a plain proxied request: this is a CONNECT proxy only', async () => {
    const response = await new Promise<string>((resolve, reject) => {
      const socket = net.createConnection(proxyPort, '127.0.0.1', () => {
        socket.write('GET http://api.github.com/ HTTP/1.1\r\nHost: api.github.com\r\n\r\n');
      });
      let buffer = '';
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
      });
      socket.on('close', () => resolve(buffer));
      socket.on('error', reject);
      socket.setTimeout(3000, () => socket.destroy());
    });

    expect(response).toContain('405');
  });
});

describe('one plan cannot use another plan\'s allowlist', () => {
  it('applies each listener its own plan\'s list', async () => {
    const otherPlan = '018f3a5c-0000-7000-8000-00000000000b';
    h.provisionEnvironment(otherPlan, { egress: ['only.other.test'] });
    const other = await proxy.listen(otherPlan, '127.0.0.1', 0);

    expect((await connectThrough('api.github.com:443', other.port)).status).toBe(403);
    expect((await connectThrough('only.other.test:443', other.port)).status).toBe(200);
    expect((await connectThrough('only.other.test:443', proxyPort)).status).toBe(403);
  });

  it('refuses everything once the environment is gone', async () => {
    h.ledger.remove(PLAN_ID);
    expect((await connectThrough('api.github.com:443')).status).toBe(403);
  });
});

describe('what the events do not carry', () => {
  it('records no request content, only host, port, and rule', async () => {
    await connectThrough('api.github.com:443');
    await connectThrough('evil.example.test:443');

    for (const event of [...h.events.ofType('egress.allowed'), ...h.events.ofType('egress.denied')]) {
      const keys = Object.keys(event.payload ?? {});
      expect(keys.every((key) => ['host', 'port', 'rule', 'reason'].includes(key))).toBe(true);
    }
  });

  it('never records a payload key that would look like a secret', async () => {
    await connectThrough('api.github.com:443');
    expect(JSON.stringify(h.events.events)).not.toMatch(/token|secret|password|api_key/i);
  });
});
