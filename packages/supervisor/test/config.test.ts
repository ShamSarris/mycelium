import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

/** The smallest environment that is allowed to start a supervisor. */
function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    SUPERVISOR_ID: '018f3a5c-0000-7000-8000-000000000001',
    ORCHESTRATOR_URL: 'http://orchestrator.tailnet:8080',
    ORCHESTRATOR_PEERS: '100.64.0.1',
    HOST: '100.64.0.2',
    ...overrides,
  };
}

describe('loadConfig - identity and reachability', () => {
  it('reads the supervisor id, the orchestrator, and the peer allowlist', () => {
    const config = loadConfig(env());
    expect(config.supervisorId).toBe('018f3a5c-0000-7000-8000-000000000001');
    expect(config.orchestratorUrl).toBe('http://orchestrator.tailnet:8080');
    expect(config.orchestratorPeers).toEqual(['100.64.0.1']);
  });

  it('splits a multi-peer allowlist and trims it', () => {
    const config = loadConfig(env({ ORCHESTRATOR_PEERS: '100.64.0.1, 100.64.0.9 ,' }));
    expect(config.orchestratorPeers).toEqual(['100.64.0.1', '100.64.0.9']);
  });

  it('refuses to start without a supervisor id', () => {
    const bare = env();
    delete bare.SUPERVISOR_ID;
    expect(() => loadConfig(bare)).toThrow(/SUPERVISOR_ID/);
  });

  it('refuses to start without an orchestrator url', () => {
    const bare = env();
    delete bare.ORCHESTRATOR_URL;
    expect(() => loadConfig(bare)).toThrow(/ORCHESTRATOR_URL/);
  });

  it('refuses to start with an empty peer allowlist, which would trust everyone', () => {
    expect(() => loadConfig(env({ ORCHESTRATOR_PEERS: '' }))).toThrow(/ORCHESTRATOR_PEERS/);
  });
});

// B19: the peer allowlist is only authentication while the process is on the
// tailnet interface and nowhere else. On a wildcard bind a packet arriving on
// another interface can carry a forged source address.
describe('loadConfig - the bind address is what makes B19 real', () => {
  it('refuses a wildcard IPv4 bind', () => {
    expect(() => loadConfig(env({ HOST: '0.0.0.0' }))).toThrow(/HOST/);
  });

  it('refuses a wildcard IPv6 bind', () => {
    expect(() => loadConfig(env({ HOST: '::' }))).toThrow(/HOST/);
  });

  it('refuses an empty bind address', () => {
    expect(() => loadConfig(env({ HOST: '' }))).toThrow(/HOST/);
  });

  it('refuses a missing bind address rather than defaulting to one', () => {
    const bare = env();
    delete bare.HOST;
    expect(() => loadConfig(bare)).toThrow(/HOST/);
  });

  it('allows a wildcard bind only under the test escape hatch', () => {
    const config = loadConfig(env({ HOST: '0.0.0.0', ALLOW_INSECURE_BIND: '1' }));
    expect(config.host).toBe('0.0.0.0');
  });

  it('accepts a loopback bind, which is what the tests use', () => {
    expect(loadConfig(env({ HOST: '127.0.0.1' })).host).toBe('127.0.0.1');
  });
});

describe('loadConfig - capacity and limits', () => {
  it('defaults capacity to two environments and four sandboxes each', () => {
    const config = loadConfig(env());
    expect(config.maxEnvironments).toBe(2);
    expect(config.maxSandboxesPerEnvironment).toBe(4);
  });

  it('overrides capacity from the environment', () => {
    expect(loadConfig(env({ MAX_ENVIRONMENTS: '5' })).maxEnvironments).toBe(5);
  });

  it('rejects a non-numeric integer setting rather than silently defaulting', () => {
    expect(() => loadConfig(env({ MAX_ENVIRONMENTS: 'lots' }))).toThrow(/MAX_ENVIRONMENTS/);
  });

  it('rejects a capacity below one, which would accept nothing', () => {
    expect(() => loadConfig(env({ MAX_ENVIRONMENTS: '0' }))).toThrow(/MAX_ENVIRONMENTS/);
  });

  it('carries the teardown grace, the TTL grace, and the heartbeat interval', () => {
    const config = loadConfig(env());
    expect(config.teardownGraceMs).toBe(5000);
    expect(config.ttlGraceMinutes).toBe(5);
    expect(config.heartbeatIntervalMs).toBe(30_000);
  });

  it('carries the sandbox defaults and the ceiling on its timeout', () => {
    const config = loadConfig(env());
    expect(config.sandboxTimeoutSec).toBe(300);
    expect(config.sandboxTimeoutCeilingSec).toBe(3600);
    expect(config.outputHeadBytes).toBe(8192);
    expect(config.outputTailBytes).toBe(8192);
    expect(config.outputMaxBytes).toBe(10 * 1024 * 1024);
  });
});

// Ticket 15: the one number both the real per-scope MemoryMax
// (`drivers/cgroup.ts`) and MAX_CONCURRENT_SUBAGENTS (`environments/provision.ts`
// -> `deriveMaxConcurrentSubagents`) are read from, so they cannot disagree.
describe('loadConfig - the agent memory ceiling', () => {
  it('is undefined when unset, which both readers treat as unbounded', () => {
    expect(loadConfig(env()).agentMemoryMaxBytes).toBeUndefined();
  });

  it('reads a configured byte ceiling', () => {
    expect(loadConfig(env({ AGENT_MEMORY_MAX_BYTES: '2147483648' })).agentMemoryMaxBytes).toBe(
      2147483648,
    );
  });

  it('rejects a non-numeric value rather than silently defaulting to unbounded', () => {
    expect(() => loadConfig(env({ AGENT_MEMORY_MAX_BYTES: 'lots' }))).toThrow(
      /AGENT_MEMORY_MAX_BYTES/,
    );
  });

  it('rejects a value below the minimum of one byte', () => {
    expect(() => loadConfig(env({ AGENT_MEMORY_MAX_BYTES: '0' }))).toThrow(
      /AGENT_MEMORY_MAX_BYTES/,
    );
  });
});

describe('loadConfig - egress and images', () => {
  it('ships a standing egress set so package installs work without a plan saying so', () => {
    const config = loadConfig(env());
    expect(config.standingEgress).toContain('registry.npmjs.org');
    expect(config.standingEgress).toContain('pypi.org');
  });

  it('replaces the standing set when the operator configures one', () => {
    const config = loadConfig(env({ STANDING_EGRESS: 'gitea.tailnet' }));
    expect(config.standingEgress).toEqual(['gitea.tailnet']);
  });

  it('lowercases the standing set, since host matching is case-insensitive', () => {
    const config = loadConfig(env({ STANDING_EGRESS: 'Gitea.Tailnet' }));
    expect(config.standingEgress).toEqual(['gitea.tailnet']);
  });

  it('starts with an empty sandbox image allowlist, so nothing runs unlisted', () => {
    expect(loadConfig(env()).sandboxImages).toEqual([]);
  });

  it('reads the sandbox image allowlist', () => {
    const config = loadConfig(env({ SANDBOX_IMAGES: 'node:22-alpine, python:3.13-slim' }));
    expect(config.sandboxImages).toEqual(['node:22-alpine', 'python:3.13-slim']);
  });
});
