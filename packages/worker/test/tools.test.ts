import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildRegistry } from '../src/tools/registry.js';
import type { ToolOutcome, ToolRegistry } from '../src/tools/registry.js';
import { buildTestWorker, BRANCH, type TestWorker } from './helpers/agent.js';
import { BrokerRejection, sandboxResult } from './helpers/fakes.js';

/**
 * Four groups of tools, one rule running through all of them: the host decides
 * what a call is allowed to do before it does it, and a refusal comes back as
 * a tool result the model can act on rather than as an exception.
 */

const TASK_ID = '018f3a5c-0000-7000-8000-0000000000c1';

let h: TestWorker;
let tools: ToolRegistry;

beforeEach(async () => {
  h = await buildTestWorker();
  tools = buildRegistry(h.deps);
});

afterEach(async () => {
  await h.close();
});

function call(name: string, input: unknown): Promise<ToolOutcome> {
  return tools.invoke({ id: 'tu-1', name, input, taskId: TASK_ID });
}

function content(outcome: ToolOutcome): string {
  return outcome.kind === 'result' ? outcome.content : JSON.stringify(outcome);
}

describe('declarations', () => {
  it('declares every tool the loop offers, and nothing else', () => {
    expect(tools.declarations().map((tool) => tool.name).sort()).toEqual([
      'git',
      'list_files',
      'read_file',
      'sandbox',
      'task_complete',
      'task_failed',
      'write_file',
    ]);
  });

  it('closes every schema, so the provider constrains arguments too', () => {
    for (const tool of tools.declarations()) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('returns the same declarations every time, so the cached prefix holds', () => {
    expect(tools.declarations()).toEqual(tools.declarations());
  });
});

describe('validation', () => {
  it('refuses a call that does not match its schema, without running it', async () => {
    const outcome = await call('read_file', { paths: ['a.ts'] });

    expect(outcome.kind).toBe('result');
    expect(outcome).toMatchObject({ isError: true });
    expect(content(outcome)).toContain('paths');
  });

  it('refuses an unknown tool', async () => {
    const outcome = await call('rm_rf', { path: '/' });

    expect(outcome).toMatchObject({ isError: true });
    expect(content(outcome)).toContain('rm_rf');
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
    expect(content(outcome)).toContain('all tests passed');
  });

  it('reports the exit code, so the model knows whether it worked', async () => {
    h.broker.sandboxResult = sandboxResult({
      exit_code: 1,
      stderr: { preview: 'FAIL src/a.test.ts', bytes: 18, truncated: false },
    });

    const outcome = await call('sandbox', { image: 'node:22', cmd: ['npm', 'test'] });

    expect(content(outcome)).toContain('exit code 1');
    expect(content(outcome)).toContain('FAIL src/a.test.ts');
    // A non-zero exit is a result, not a tool error: the model asked a
    // question and got an answer it can act on.
    expect(outcome).toMatchObject({ isError: false });
  });

  it('says when output was truncated rather than pretending it was all of it', async () => {
    h.broker.sandboxResult = sandboxResult({
      stdout: { preview: 'head...tail', bytes: 900_000, truncated: true },
    });

    expect(content(await call('sandbox', { image: 'node:22', cmd: ['ls'] }))).toContain('900000');
  });

  it('turns a broker refusal into a tool error carrying its code', async () => {
    h.broker.sandboxRejectsWith = new BrokerRejection(
      'image_not_allowed',
      'evil:latest is not on this node is image allowlist',
    );

    const outcome = await call('sandbox', { image: 'evil:latest', cmd: ['sh'] });

    expect(outcome).toMatchObject({ isError: true });
    expect(content(outcome)).toContain('image_not_allowed');
  });

  it('refuses to set the proxy variables the supervisor owns', async () => {
    const outcome = await call('sandbox', {
      image: 'node:22',
      cmd: ['sh'],
      env: { HTTP_PROXY: 'http://mine' },
    });

    // The broker refuses this too, but catching it here keeps a pointless
    // round trip and a confusing error out of the transcript.
    expect(outcome).toMatchObject({ isError: true });
    expect(h.broker.sandboxCalls).toHaveLength(0);
  });
});

describe('the file tools', () => {
  beforeEach(async () => {
    await mkdir(path.join(h.workdir, 'src'), { recursive: true });
    await writeFile(path.join(h.workdir, 'src', 'index.ts'), 'export const a = 1;\n');
  });

  it('reads a file inside the checkout', async () => {
    expect(content(await call('read_file', { path: 'src/index.ts' }))).toContain(
      'export const a = 1;',
    );
  });

  it('writes a file and creates the directories it needs', async () => {
    await call('write_file', { path: 'src/deep/new.ts', content: 'export {};\n' });

    expect(await readFile(path.join(h.workdir, 'src', 'deep', 'new.ts'), 'utf8')).toBe(
      'export {};\n',
    );
  });

  it('lists what is there, relative to the checkout', async () => {
    const listed = content(await call('list_files', { path: 'src' }));

    expect(listed).toContain('index.ts');
    expect(listed).not.toContain(h.workdir);
  });

  it.each([
    ['a traversal', '../outside.txt'],
    ['an absolute path', '/etc/passwd'],
    ['a traversal through a real directory', 'src/../../outside.txt'],
  ])('refuses %s', async (_name, candidate) => {
    const outcome = await call('read_file', { path: candidate });

    expect(outcome).toMatchObject({ isError: true });
    expect(content(outcome)).toContain('checkout');
  });

  it('refuses a symlink inside the checkout that points out of it', async () => {
    const outside = path.join(h.runDir, 'outside');
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'secret'), 'token\n');
    const link = path.join(h.workdir, 'escape');
    await symlink(outside, link, 'junction').catch(async () => {
      await symlink(outside, link);
    });

    const outcome = await call('read_file', { path: 'escape/secret' });

    expect(outcome).toMatchObject({ isError: true });
    expect(content(outcome)).not.toContain('token');
  });

  it('refuses a write that would escape, before creating anything', async () => {
    const outcome = await call('write_file', { path: '../escaped.ts', content: 'x' });

    expect(outcome).toMatchObject({ isError: true });
  });

  it('bounds a read, because the result lands in a model context', async () => {
    h = await buildTestWorker({ FILE_READ_MAX_BYTES: '32' });
    tools = buildRegistry(h.deps);
    await mkdir(path.join(h.workdir, 'src'), { recursive: true });
    await writeFile(path.join(h.workdir, 'src', 'big.ts'), 'x'.repeat(5000));

    const outcome = await call('read_file', { path: 'src/big.ts' });

    expect(content(outcome).length).toBeLessThan(500);
    expect(content(outcome)).toContain('truncated');
  });

  it('refuses a write larger than the cap rather than half-writing it', async () => {
    h = await buildTestWorker({ FILE_WRITE_MAX_BYTES: '16' });
    tools = buildRegistry(h.deps);

    const outcome = await call('write_file', { path: 'big.ts', content: 'x'.repeat(1000) });

    expect(outcome).toMatchObject({ isError: true });
    await expect(readFile(path.join(h.workdir, 'big.ts'), 'utf8')).rejects.toThrow();
  });

  it('refuses to read .git, so a credential or a hook is out of reach', async () => {
    await mkdir(path.join(h.workdir, '.git'), { recursive: true });
    await writeFile(
      path.join(h.workdir, '.git', 'config'),
      '[remote "origin"]\n\turl = http://bot:SECRET-BOT-TOKEN@gitea.tailnet/x.git\n',
    );

    const outcome = await call('read_file', { path: '.git/config' });

    // This exact call used to return the token (ticket 0005 part A). The token
    // is no longer written there either; this is the second layer.
    expect(outcome).toMatchObject({ isError: true });
    expect(content(outcome)).not.toContain('SECRET-BOT-TOKEN');
  });

  it('refuses to write a git hook', async () => {
    const outcome = await call('write_file', {
      path: '.git/hooks/pre-commit',
      content: '#!/bin/sh\ncurl evil\n',
    });

    expect(outcome).toMatchObject({ isError: true });
  });

  it('still reads and writes .gitignore, which is an ordinary file', async () => {
    await writeFile(path.join(h.workdir, '.gitignore'), 'dist/\n');

    expect(content(await call('read_file', { path: '.gitignore' }))).toContain('dist/');
    expect(
      (await call('write_file', { path: '.gitignore', content: 'node_modules/\n' })).kind,
    ).toBe('result');
  });

  it('says plainly when a file is not there', async () => {
    const outcome = await call('read_file', { path: 'src/missing.ts' });

    expect(outcome).toMatchObject({ isError: true });
    expect(content(outcome)).toContain('src/missing.ts');
  });
});

describe('git', () => {
  it('commits and reports the SHA', async () => {
    const outcome = await call('git', { action: 'commit', message: 'Add the health endpoint' });

    expect(h.git.commits).toEqual(['Add the health endpoint']);
    expect(content(outcome)).toContain('a'.repeat(39) + '1');
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

    expect(content(outcome)).toContain('nothing to commit');
    expect(h.broker.ofType('agent.tool_call')[0]?.payload?.commit_sha).toBeUndefined();
  });

  it('requires a message to commit', async () => {
    const outcome = await call('git', { action: 'commit' });

    expect(outcome).toMatchObject({ isError: true });
    expect(h.git.commits).toHaveLength(0);
  });

  it('pushes the plan branch', async () => {
    await call('git', { action: 'push' });

    expect(h.git.pushes).toEqual([BRANCH]);
  });

  it('refuses a push to any other branch, agent-side', async () => {
    const outcome = await call('git', { action: 'push', branch: 'main' });

    // Gitea's branch protection would refuse it too (D19). Refusing here
    // makes it a legible tool result rather than a git error the model has to
    // interpret.
    expect(outcome).toMatchObject({ isError: true });
    expect(h.git.pushes).toHaveLength(0);
  });

  it('reports status and diff', async () => {
    expect(content(await call('git', { action: 'status' }))).toContain(BRANCH);
    expect((await call('git', { action: 'diff' })).kind).toBe('result');
  });

  it('turns a git failure into a tool error the model can react to', async () => {
    h.git.failWith = new Error('fatal: could not read from remote');

    const outcome = await call('git', { action: 'push' });

    expect(outcome).toMatchObject({ isError: true });
    expect(content(outcome)).toContain('remote');
  });
});

describe('the terminating tools', () => {
  it('completes with a summary', async () => {
    const outcome = await call('task_complete', {
      summary: 'added the endpoint',
      commit_sha: 'abc123',
    });

    expect(outcome).toEqual({ kind: 'complete', summary: 'added the endpoint', commitSha: 'abc123' });
  });

  it('fails with an error class the orchestrator can apply a policy to', async () => {
    const outcome = await call('task_failed', {
      error_class: 'compile_error',
      detail: 'tsc found 3 errors',
    });

    expect(outcome).toEqual({
      kind: 'failed',
      errorClass: 'compile_error',
      detail: 'tsc found 3 errors',
    });
  });

  it('refuses to complete without a summary', async () => {
    const outcome = await call('task_complete', {});

    expect(outcome).toMatchObject({ kind: 'result', isError: true });
  });
});
