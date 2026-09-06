import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { normaliseAddress } from '../src/auth/peer.js';
import { ORCHESTRATOR_PEER, buildTestApp, type TestHarness } from './helpers/app.js';

let h: TestHarness;

beforeAll(async () => {
  h = await buildTestApp();
});

afterAll(async () => {
  await h.close();
});

beforeEach(() => {
  h.reset();
});

describe('normaliseAddress', () => {
  it('reduces the IPv4-mapped IPv6 form Node reports on a dual-stack socket', () => {
    expect(normaliseAddress('::ffff:100.64.0.1')).toBe('100.64.0.1');
    expect(normaliseAddress('::FFFF:100.64.0.1')).toBe('100.64.0.1');
  });

  it('leaves a plain address alone', () => {
    expect(normaliseAddress('100.64.0.1')).toBe('100.64.0.1');
  });

  it('returns null when there is no address at all', () => {
    expect(normaliseAddress(undefined)).toBeNull();
    expect(normaliseAddress('')).toBeNull();
  });
});

describe('the dispatch routes are closed to unlisted peers (B19)', () => {
  it('lets the configured orchestrator through', async () => {
    const response = await h.dispatch({ remoteAddress: ORCHESTRATOR_PEER });
    expect(response.statusCode).not.toBe(403);
  });

  it('lets it through when Node reports the mapped IPv6 form', async () => {
    const response = await h.dispatch({ remoteAddress: `::ffff:${ORCHESTRATOR_PEER}` });
    expect(response.statusCode).not.toBe(403);
  });

  it('refuses another tailnet node', async () => {
    const response = await h.dispatch({ remoteAddress: '100.64.0.99' });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('peer_not_allowed');
  });

  it('refuses loopback, which is not the orchestrator', async () => {
    const response = await h.dispatch({ remoteAddress: '127.0.0.1' });
    expect(response.statusCode).toBe(403);
  });

  it('does not tell the caller which address it saw', async () => {
    const response = await h.dispatch({ remoteAddress: '100.64.0.99' });
    expect(response.body).not.toContain('100.64.0.99');
  });

  it('guards teardown as well as dispatch', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/plans/018f3a5c-0000-7000-8000-00000000000a/teardown',
      remoteAddress: '100.64.0.99',
      payload: { reason: 'cancelled' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('guards task dispatch as well', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/plans/018f3a5c-0000-7000-8000-00000000000a/tasks',
      remoteAddress: '100.64.0.99',
      payload: {},
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('the error body the orchestrator client parses', () => {
  // HttpSupervisorClient reads body.code, not body.error.code. Nesting it would
  // turn every terminal rejection into a retryable one.
  it('puts code at the top level, unlike the orchestrator', async () => {
    const response = await h.dispatch({ remoteAddress: '100.64.0.99' });
    const body = response.json();
    expect(body).toHaveProperty('code');
    expect(body).not.toHaveProperty('error');
  });

  it('answers an unknown route in the same shape', async () => {
    const response = await h.app.inject({
      method: 'GET',
      url: '/nope',
      remoteAddress: ORCHESTRATOR_PEER,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe('not_found');
  });
});

describe('GET /healthz', () => {
  it('answers without the peer allowlist, so the operator can curl it', async () => {
    const response = await h.app.inject({
      method: 'GET',
      url: '/healthz',
      remoteAddress: '127.0.0.1',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, environments: 0, capacity: 2 });
  });

  it('reports occupancy without naming any plan', async () => {
    await h.provisionEnvironment('018f3a5c-0000-7000-8000-00000000000a');
    const response = await h.app.inject({
      method: 'GET',
      url: '/healthz',
      remoteAddress: '127.0.0.1',
    });

    expect(response.json().environments).toBe(1);
    expect(response.body).not.toContain('018f3a5c');
  });
});
