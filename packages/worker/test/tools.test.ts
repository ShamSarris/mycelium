import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCommitBox, type CommitBox } from '../src/runner/cadence.js';
import {
  buildMyceliumServer,
  createTerminalOutcomeBox,
  type TerminalOutcomeBox,
} from '../src/runner/tools.js';
import { buildTestWorker, BRANCH, type TestWorker } from './helpers/agent.js';
import { BrokerRejection, sandboxResult } from './helpers/fakes.js';

/**
 * The worker's tools, re-expressed as an in-process MCP server (ticket 10).
 * Every test drives the *real* MCP protocol path — an in-memory client
 * connected to the server's own `McpServer` instance, exactly the shape the
 * Agent SDK's own internal client will use in ticket 11 — rather than calling
 * a tool's handler function directly. That is what makes the validation
 * tests (wrong type / missing required / unknown extra property) mean
 * anything: they are proving what the protocol boundary does, not what one
 * function happens to do when called correctly.
 */

const TASK_ID = '018f3a5c-0000-7000-8000-0000000000c1';

let h: TestWorker;
let outcomeBox: TerminalOutcomeBox;
let commitBox: CommitBox;
let client: Client;

beforeEach(async () => {
  h = await buildTestWorker();
  outcomeBox = createTerminalOutcomeBox();
  commitBox = createCommitBox();
  const server = buildMyceliumServer(h.deps, outcomeBox, TASK_ID, commitBox);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.instance.connect(serverTransport)]);
});

afterEach(async () => {
  await client.close();
  await h.close();
});

interface Outcome {
  content: string;
  isError: boolean;
}

async function call(name: string, args: unknown): Promise<Outcome> {
  const result = await client.callTool({ name, arguments: args as Record<string, unknown> });
  const blocks = result.content as Array<{ type: string; text?: string }>;
  const content = blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');
  return { content, isError: Boolean(result.isError) };
}

describe('the mycelium MCP server', () => {
  it('exposes exactly the four surviving tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'git',
      'sandbox',
      'task_complete',
      'task_failed',
    ]);
  });

  it('closes every tool schema, so an unknown key is refused like the old additionalProperties: false', async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect((tool.inputSchema as Record<string, unknown>).additionalProperties).toBe(false);
    }
  });
});

describe('validation', () => {
  it('refuses a call missing a required field, without running it', async () => {
    const outcome = await call('sandbox', { image: 'node:22' }); // no cmd

    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain('cmd');
    expect(h.broker.sandboxCalls).toHaveLength(0);
  });

  it('refuses a call whose field is the wrong type', async () => {
    const outcome = await call('sandbox', { image: 'node:22', cmd: 'npm test' }); // cmd is a string, not an array

    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain('cmd');
    expect(h.broker.sandboxCalls).toHaveLength(0);
  });

  it('refuses a call carrying an unknown extra property', async () => {
    const outcome = await call('sandbox', { image: 'node:22', cmd: ['npm', 'test'], bogus: 1 });

    expect(outcome.isError).toBe(true);
    expect(h.broker.sandboxCalls).toHaveLength(0);
  });

  it('refuses an unknown tool, as isError content rather than a thrown exception', async () => {
    const outcome = await call('rm_rf', { path: '/' });

    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain('rm_rf');
  });

  it('never reaches the broker for a call it refused', async () => {
    await call('sandbox', { image: 'node:22' }); // no cmd

    expect(h.broker.sandboxCalls).toHaveLength(0);
  });
});

describe('sandbox', () => {
  it('passes the call to the broker untouched', async () => {
    h.broker.sandboxResult = sandboxResult({
      stdout: { preview: 'all tests passed', bytes: 16, truncated: false },
    });

    const outcome = await call('sandbox', {
      image: 'node:22',
      cmd: ['npm', 'test'],
      network: true,
      timeout_sec: 120,
    });

    expect(h.broker.sandboxCalls[0]).toEqual({
      image: 'node:22',
      cmd: ['npm', 'test'],
      network: true,
      limits: { timeout_sec: 120 },
    });
    expect(outcome.content).toContain('all tests passed');
  });

  it('reports the exit code, so the model knows whether it worked', async () => {
    h.broker.sandboxResult = sandboxResult({
      exit_code: 1,
      stderr: { preview: 'FAIL src/a.test.ts', bytes: 18, truncated: false },
    });

    const outcome = await call('sandbox', { image: 'node:22', cmd: ['npm', 'test'] });

    expect(outcome.content).toContain('exit code 1');
    expect(outcome.content).toContain('FAIL src/a.test.ts');
    // A non-zero exit is a result, not a tool error: the model asked a
    // question and got an answer it can act on.
    expect(outcome.isError).toBe(false);
  });

  it('says when output was truncated rather than pretending it was all of it', async () => {
    h.broker.sandboxResult = sandboxResult({
      stdout: { preview: 'head...tail', bytes: 900_000, truncated: true },
    });

    const outcome = await call('sandbox', { image: 'node:22', cmd: ['ls'] });
    expect(outcome.content).toContain('900000');
  });

  it('folds env pairs into a map for the broker', async () => {
    h.broker.sandboxResult = sandboxResult({
      stdout: { preview: 'ok', bytes: 2, truncated: false },
    });

    await call('sandbox', {
      image: 'node:22',
      cmd: ['env'],
      env: [
        { name: 'CI', value: '1' },
        { name: 'TZ', value: 'UTC' },
      ],
    });

    expect(h.broker.sandboxCalls[0]).toMatchObject({ env: { CI: '1', TZ: 'UTC' } });
  });

  it('turns a broker refusal into a tool error carrying its code', async () => {
    h.broker.sandboxRejectsWith = new BrokerRejection(
      'image_not_allowed',
      'evil:latest is not on this node is image allowlist',
    );

    const outcome = await call('sandbox', { image: 'evil:latest', cmd: ['sh'] });

    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain('image_not_allowed');
  });

  it('refuses to set the proxy variables the supervisor owns', async () => {
    const outcome = await call('sandbox', {
      image: 'node:22',
      cmd: ['sh'],
      env: [{ name: 'HTTP_PROXY', value: 'http://mine' }],
    });

    // The broker refuses this too, but catching it here keeps a pointless
    // round trip and a confusing error out of the transcript.
    expect(outcome.isError).toBe(true);
    expect(h.broker.sandboxCalls).toHaveLength(0);
  });

  it('refuses an empty cmd array, argv must have at least one element', async () => {
    const outcome = await call('sandbox', { image: 'node:22', cmd: [] });

    expect(outcome.isError).toBe(true);
    expect(h.broker.sandboxCalls).toHaveLength(0);
  });

  it('refuses a non-positive timeout_sec', async () => {
    const outcome = await call('sandbox', { image: 'node:22', cmd: ['ls'], timeout_sec: 0 });

    expect(outcome.isError).toBe(true);
    expect(h.broker.sandboxCalls).toHaveLength(0);
  });
});

describe('git', () => {
  it('commits and reports the SHA', async () => {
    const outcome = await call('git', { action: 'commit', message: 'Add the health endpoint' });

    expect(h.git.commits).toEqual(['Add the health endpoint']);
    expect(outcome.content).toContain('a'.repeat(39) + '1');
  });

  it('emits a tool-call event carrying the SHA, so history joins the event log', async () => {
    await call('git', { action: 'commit', message: 'Add the health endpoint' });

    const events = h.broker.ofType('agent.tool_call');
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ tool: 'git', action: 'commit' });
    expect(events[0]?.payload?.commit_sha).toBe('a'.repeat(39) + '1');
  });

  it('says there was nothing to commit rather than inventing a SHA', async () => {
    h.git.nothingToCommit = true;

    const outcome = await call('git', { action: 'commit', message: 'nothing' });

    expect(outcome.content).toContain('nothing to commit');
    expect(h.broker.ofType('agent.tool_call')[0]?.payload?.commit_sha).toBeUndefined();
  });

  it('requires a message to commit', async () => {
    const outcome = await call('git', { action: 'commit' });

    expect(outcome.isError).toBe(true);
    expect(h.git.commits).toHaveLength(0);
  });

  it('pushes the plan branch', async () => {
    await call('git', { action: 'push' });

    expect(h.git.pushes).toEqual([BRANCH]);
  });

  it('refuses a push to any other branch, agent-side', async () => {
    const outcome = await call('git', { action: 'push', branch: 'main' });

    // Gitea's branch protection would refuse it too (D19). Refusing here
    // makes it a legible tool result rather than a git error the model has
    // to interpret.
    expect(outcome.isError).toBe(true);
    expect(h.git.pushes).toHaveLength(0);
  });

  it('reports status and diff', async () => {
    const status = await call('git', { action: 'status' });
    expect(status.content).toContain(BRANCH);

    const diff = await call('git', { action: 'diff' });
    expect(diff.isError).toBe(false);
  });

  it('records a successful commit for the cadence instrument', async () => {
    expect(commitBox.commits).toBe(0);

    await call('git', { action: 'commit', message: 'Add the health endpoint' });

    // `runner/cadence.ts` counts tool calls since the last commit. It can
    // only reset if the commit is recorded here, before the tool result that
    // carries it reaches the runner.
    expect(commitBox.commits).toBe(1);
  });

  it('does not record a commit that had nothing to commit', async () => {
    h.git.nothingToCommit = true;

    await call('git', { action: 'commit', message: 'nothing' });

    expect(commitBox.commits).toBe(0);
  });

  it('does not record a push, a status, or a diff as a commit', async () => {
    await call('git', { action: 'push' });
    await call('git', { action: 'status' });
    await call('git', { action: 'diff' });

    expect(commitBox.commits).toBe(0);
  });

  it('turns a git failure into a tool error the model can react to', async () => {
    h.git.failWith = new Error('fatal: could not read from remote');

    const outcome = await call('git', { action: 'push' });

    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain('remote');
  });

  it('refuses an unrecognized action, closing the enum like the old schema did', async () => {
    const outcome = await call('git', { action: 'rebase' });

    expect(outcome.isError).toBe(true);
  });
});

describe('the terminating tools', () => {
  it('records a completion in the outcome box and tells the model plainly', async () => {
    const outcome = await call('task_complete', {
      summary: 'added the endpoint',
      commit_sha: 'abc123',
    });

    expect(outcome.isError).toBe(false);
    expect(outcomeBox.outcome).toEqual({
      kind: 'complete',
      summary: 'added the endpoint',
      commitSha: 'abc123',
    });
  });

  it('records a failure in the outcome box with an error class the orchestrator can apply a policy to', async () => {
    const outcome = await call('task_failed', {
      error_class: 'compile_error',
      detail: 'tsc found 3 errors',
    });

    expect(outcome.isError).toBe(false);
    expect(outcomeBox.outcome).toEqual({
      kind: 'failed',
      errorClass: 'compile_error',
      detail: 'tsc found 3 errors',
    });
  });

  it('refuses to complete without a summary, and does not touch the outcome box', async () => {
    const outcome = await call('task_complete', {});

    expect(outcome.isError).toBe(true);
    expect(outcomeBox.outcome).toBeNull();
  });

  it('leaves the outcome box null until a terminal tool is called', () => {
    expect(outcomeBox.outcome).toBeNull();
  });
});

describe('tool descriptions', () => {
  it('are carried over byte-identical from the original declarations', async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool.description]));

    expect(byName.get('sandbox')).toBe(
      'Run a command in an isolated container with the plan checkout mounted at /workspace. ' +
        'This is how you build, test, and run anything. The container has no route to the ' +
        'internet except the plan allowlist, and it holds no credentials.',
    );
    expect(byName.get('git')).toBe(
      'Commit and push your work on the plan branch. Commit at every checkpoint and push ' +
        'often: work that is not pushed does not survive the environment being torn down.',
    );
    expect(byName.get('task_complete')).toBe(
      'End the task successfully. Call this when the work is done and pushed. This is the ' +
        'only way to report success; text alone does not end the task.',
    );
    expect(byName.get('task_failed')).toBe(
      'End the task as failed. Call this when the work cannot be done. Failing honestly is ' +
        'better than reporting a success you cannot support; the orchestrator decides what ' +
        'happens next, and you must not retry the task yourself.',
    );
  });
});
