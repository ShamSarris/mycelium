import { describe, expect, it } from 'vitest';
import { loadConfig, REQUIRED_VARIABLES } from '../src/config.js';

/**
 * The plan agent is started by the supervisor with a fully populated
 * environment ([provision.ts:100-113]) and never by hand. A missing variable is
 * therefore a supervisor bug, and the only useful response is to fail at boot
 * naming the variable — a half-configured agent accepts a task and fails it
 * later, which is strictly worse than never starting.
 */

/** Exactly what environments/provision.ts injects, minus what the agent defaults. */
function injectedEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    PLAN_ID: '11111111-1111-4111-8111-111111111111',
    PROJECT_ID: '22222222-2222-4222-8222-222222222222',
    PROJECT_NAME: 'mycelium',
    ORCHESTRATOR_URL: 'http://100.64.0.1:8080/',
    ORCHESTRATOR_TOKEN: 'plan-token',
    GITEA_BOT_TOKEN: 'bot-token',
    GITEA_BRANCH: 'plan/11111111-1111-4111-8111-111111111111',
    MODEL_API_KEY: 'sk-ant-test',
    AGENT_SOCKET: '/srv/plan/run/broker.sock',
    DISPATCH_SOCKET: '/srv/plan/run/dispatch.sock',
    WORKDIR: '/srv/plan/repo',
    MAX_CONCURRENT_SUBAGENTS: '2',
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe('loadConfig', () => {
  it('reads every variable the supervisor injects', () => {
    const config = loadConfig(injectedEnv());

    expect(config.planId).toBe('11111111-1111-4111-8111-111111111111');
    expect(config.projectId).toBe('22222222-2222-4222-8222-222222222222');
    expect(config.projectName).toBe('mycelium');
    expect(config.brokerSocket).toBe('/srv/plan/run/broker.sock');
    expect(config.dispatchSocket).toBe('/srv/plan/run/dispatch.sock');
    expect(config.workdir).toBe('/srv/plan/repo');
    expect(config.branch).toBe('plan/11111111-1111-4111-8111-111111111111');
    expect(config.maxConcurrentSubagents).toBe(2);
  });

  it('trims the orchestrator URL of its trailing slash, as the supervisor does', () => {
    const config = loadConfig(injectedEnv());
    expect(config.orchestratorUrl).toBe('http://100.64.0.1:8080');
  });

  it('keeps the three credentials together, away from the rest of the config', () => {
    const config = loadConfig(injectedEnv());

    // Nested deliberately: logging `config` should not be the way a token
    // reaches a log line, and one field is easier to redact than three.
    expect(config.credentials).toEqual({
      orchestratorToken: 'plan-token',
      giteaBotToken: 'bot-token',
      modelApiKey: 'sk-ant-test',
    });
    expect(JSON.stringify({ ...config, credentials: undefined })).not.toContain('sk-ant-test');
  });

  it.each(REQUIRED_VARIABLES)('throws naming %s when it is missing', (name) => {
    expect(() => loadConfig(injectedEnv({ [name]: undefined }))).toThrow(name);
  });

  it.each(REQUIRED_VARIABLES)('throws naming %s when it is blank', (name) => {
    expect(() => loadConfig(injectedEnv({ [name]: '   ' }))).toThrow(name);
  });

  it('defaults the model settings', () => {
    const config = loadConfig(injectedEnv());

    expect(config.modelId).toBe('claude-opus-5');
    expect(config.modelEffort).toBe('high');
    expect(config.modelMaxTokens).toBe(64_000);
    expect(config.bytesPerToken).toBe(3);
  });

  it('defaults the timings, retries, and the commit-cadence threshold', () => {
    const config = loadConfig(injectedEnv());

    expect(config.brokerTimeoutMs).toBe(10_000);
    expect(config.orchestratorTimeoutMs).toBe(10_000);
    // B15 gives the whole shutdown five seconds and the event flush comes
    // first, so the status POST gets a fraction of it.
    expect(config.shutdownStatusTimeoutMs).toBe(2000);
    expect(config.statusRetryLimit).toBe(3);
    expect(config.statusRetryWindowMs).toBe(30_000);
    expect(config.commitCadenceWarnAfter).toBe(25);
    expect(config.fileReadMaxBytes).toBe(256 * 1024);
    expect(config.fileWriteMaxBytes).toBe(1024 * 1024);
    expect(config.listFilesMaxEntries).toBe(500);
    expect(config.maxConcurrentSubagents).toBe(2);
  });

  it('overrides maxConcurrentSubagents from the supervisor-injected env var, not the plan', () => {
    const config = loadConfig(injectedEnv({ MAX_CONCURRENT_SUBAGENTS: '7' }));
    expect(config.maxConcurrentSubagents).toBe(7);
  });

  it('defaults to the host-owned loop until ticket 14 flips the default', () => {
    const config = loadConfig(injectedEnv());
    expect(config.taskRunner).toBe('host');
  });

  it('selects the agent-sdk runner from TASK_RUNNER', () => {
    const config = loadConfig(injectedEnv({ TASK_RUNNER: 'agent-sdk' }));
    expect(config.taskRunner).toBe('agent-sdk');
  });

  it('rejects a TASK_RUNNER value that is neither host nor agent-sdk', () => {
    expect(() => loadConfig(injectedEnv({ TASK_RUNNER: 'host-loop' }))).toThrow('TASK_RUNNER');
  });

  it('defaults claudeConfigDir to a per-plan directory outside the checkout', () => {
    const config = loadConfig(injectedEnv());
    // Outside the checkout (WORKDIR), and derived from it rather than shared
    // across plans, since the isolation this backs (agent-sdk.ts §3) must
    // never let one plan's Claude Code state influence another's.
    expect(config.claudeConfigDir).not.toBe(config.workdir);
    expect(config.claudeConfigDir.startsWith(config.workdir)).toBe(false);
  });

  it('overrides claudeConfigDir from the environment', () => {
    const config = loadConfig(injectedEnv({ CLAUDE_CONFIG_DIR: '/srv/plan/claude-config' }));
    expect(config.claudeConfigDir).toBe('/srv/plan/claude-config');
  });

  it('overrides the defaults from the environment', () => {
    const config = loadConfig(
      injectedEnv({
        MODEL_ID: 'claude-sonnet-5',
        MODEL_EFFORT: 'max',
        MODEL_MAX_TOKENS: '32000',
        BYTES_PER_TOKEN: '4',
        COMMIT_CADENCE_WARN_AFTER: '10',
      }),
    );

    expect(config.modelId).toBe('claude-sonnet-5');
    expect(config.modelEffort).toBe('max');
    expect(config.modelMaxTokens).toBe(32_000);
    expect(config.bytesPerToken).toBe(4);
    expect(config.commitCadenceWarnAfter).toBe(10);
  });

  it('rejects an effort level the API does not accept', () => {
    expect(() => loadConfig(injectedEnv({ MODEL_EFFORT: 'extreme' }))).toThrow('MODEL_EFFORT');
  });

  it('rejects a non-integer or out-of-range number rather than silently defaulting', () => {
    expect(() => loadConfig(injectedEnv({ MODEL_MAX_TOKENS: 'lots' }))).toThrow('MODEL_MAX_TOKENS');
    // Guessing low is the dangerous direction for the estimator: it would
    // under-reserve and let a task overrun its ceiling.
    expect(() => loadConfig(injectedEnv({ BYTES_PER_TOKEN: '0' }))).toThrow('BYTES_PER_TOKEN');
  });
});
