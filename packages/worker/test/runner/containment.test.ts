import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestWorker, type TestWorker } from '../helpers/agent.js';
import { containmentDecision, createContainmentHook } from '../../src/runner/containment.js';

/**
 * Ticket 12: the `PreToolUse` hook that contains the SDK's built-in file
 * tools (Read/Write/Edit/Glob/Grep) to the plan checkout. `containmentDecision`
 * is a pure function — no SDK, no subprocess, no network — tested here against
 * a real filesystem fixture, the same way `test/domain/paths.test.ts` tests
 * the `containedAbsolutePath`/`realContainedPath` primitives it is built on.
 *
 * 01-findings.md Q4 is UNRESOLVED (hook shape and deny-capability confirmed
 * only from the SDK's `.d.ts`; runtime path format and enforcement never
 * observed live from this session). These tests can only prove the *decision
 * function* is correct; they cannot prove the SDK actually honors a `deny`
 * decision or actually delivers absolute paths at runtime. See
 * `test/integration/live-model.test.ts` for the `WORKER_LIVE_TESTS=1`-gated
 * live confirmation of both, which this ticket adds but does not run.
 */

let root: string;
let workdir: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'mycelium-containment-'));
  workdir = path.join(root, 'repo');
  await mkdir(path.join(workdir, 'src'), { recursive: true });
  await writeFile(path.join(workdir, 'src', 'index.ts'), 'export {};\n');
  await writeFile(path.join(workdir, '.gitignore'), 'node_modules\n');

  // A sibling whose name starts with the workdir's, for the prefix trick.
  await mkdir(path.join(root, 'repo-evil'), { recursive: true });
  await writeFile(path.join(root, 'repo-evil', 'secret'), 'token\n');

  // A symlink inside the workdir pointing at that sibling.
  const link = path.join(workdir, 'escape');
  await symlink(path.join(root, 'repo-evil'), link, 'junction').catch(async () => {
    await symlink(path.join(root, 'repo-evil'), link);
  });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('containmentDecision — deny cases', () => {
  it('denies Read of a credential file outside the workdir', async () => {
    const result = await containmentDecision(workdir, 'Read', {
      file_path: '/etc/mycelium/creds/model_api_key.cred',
    });
    expect(result.allow).toBe(false);
  });

  it('denies Read of /etc/passwd', async () => {
    const result = await containmentDecision(workdir, 'Read', { file_path: '/etc/passwd' });
    expect(result.allow).toBe(false);
  });

  it('denies Write outside the workdir', async () => {
    const result = await containmentDecision(workdir, 'Write', {
      file_path: path.join(root, 'outside.txt'),
      content: 'x',
    });
    expect(result.allow).toBe(false);
  });

  it('denies Edit of a path resolving out via ..', async () => {
    const candidate = `${workdir}${path.sep}..${path.sep}escaped.txt`;
    const result = await containmentDecision(workdir, 'Edit', {
      file_path: candidate,
      old_string: 'a',
      new_string: 'b',
    });
    expect(result.allow).toBe(false);
  });

  it('denies any tool touching a whole-segment .git path', async () => {
    const result = await containmentDecision(workdir, 'Read', {
      file_path: path.join(workdir, '.git', 'config'),
    });
    expect(result.allow).toBe(false);
  });

  it('denies the sibling-prefix trick (<workdir>-evil/...)', async () => {
    const result = await containmentDecision(workdir, 'Read', {
      file_path: path.join(root, 'repo-evil', 'secret'),
    });
    expect(result.allow).toBe(false);
  });

  it('denies a symlink inside the workdir pointing out', async () => {
    const result = await containmentDecision(workdir, 'Read', {
      file_path: path.join(workdir, 'escape', 'secret'),
    });
    expect(result.allow).toBe(false);
  });

  it('never puts the resolved absolute path in the denial reason, only the candidate', async () => {
    const candidate = '/etc/mycelium/creds/model_api_key.cred';
    const result = await containmentDecision(workdir, 'Read', { file_path: candidate });
    expect(result.allow).toBe(false);
    if (result.allow) throw new Error('unreachable');
    expect(result.reason).toContain(candidate);
    // The resolved form would place the candidate directly under the
    // workdir root — assert that string never shows up in the reason.
    expect(result.reason).not.toContain(workdir);
  });
});

describe('containmentDecision — allow cases', () => {
  it('allows an ordinary file in the workdir', async () => {
    const result = await containmentDecision(workdir, 'Read', {
      file_path: path.join(workdir, 'src', 'index.ts'),
    });
    expect(result.allow).toBe(true);
  });

  it('allows a not-yet-existing file in the workdir (Write creates it)', async () => {
    const result = await containmentDecision(workdir, 'Write', {
      file_path: path.join(workdir, 'src', 'new-file.ts'),
      content: 'export {};\n',
    });
    expect(result.allow).toBe(true);
  });

  it('allows .gitignore', async () => {
    const result = await containmentDecision(workdir, 'Read', {
      file_path: path.join(workdir, '.gitignore'),
    });
    expect(result.allow).toBe(true);
  });

  it('allows a nested subdirectory', async () => {
    const result = await containmentDecision(workdir, 'Glob', {
      pattern: '*.ts',
      path: path.join(workdir, 'src'),
    });
    expect(result.allow).toBe(true);
  });
});

describe('containmentDecision — Glob/Grep path handling', () => {
  // 01-findings.md Q4: Glob/Grep's optional `path` is not documented
  // absolute-only the way file_path is, and was observed live to arrive
  // *absent* when the model omits it — not merely "may be relative".

  it('allows a relative Glob pattern resolved against workdir (decision (a))', async () => {
    const result = await containmentDecision(workdir, 'Glob', {
      pattern: '*.ts',
      path: 'src',
    });
    expect(result.allow).toBe(true);
  });

  it('denies a relative Glob path that escapes the workdir', async () => {
    const result = await containmentDecision(workdir, 'Glob', {
      pattern: '*',
      path: '../repo-evil',
    });
    expect(result.allow).toBe(false);
  });

  it('treats an omitted Grep path as "search from workdir" (decision (b)) and allows it', async () => {
    const result = await containmentDecision(workdir, 'Grep', { pattern: 'TODO' });
    expect(result.allow).toBe(true);
  });

  it('denies an absolute Grep path outside the workdir', async () => {
    const result = await containmentDecision(workdir, 'Grep', {
      pattern: 'TODO',
      path: '/etc',
    });
    expect(result.allow).toBe(false);
  });
});

describe('containmentDecision — unknown tools', () => {
  it('denies a tool name it does not recognize, rather than allowing it through unchecked', async () => {
    const result = await containmentDecision(workdir, 'WebFetch', { url: 'https://example.com' });
    expect(result.allow).toBe(false);
  });

  it('allows the Agent tool without a path check (ticket 13: spawning a subagent is not a file operation)', async () => {
    const result = await containmentDecision(workdir, 'Agent', {
      description: 'look around',
      prompt: 'find the auth module',
      subagent_type: 'explorer',
    });
    expect(result.allow).toBe(true);
  });

  it('allows the worker\'s own non-file MCP tools without a path check', async () => {
    const sandbox = await containmentDecision(workdir, 'mcp__mycelium__sandbox', { cmd: ['echo', 'hi'] });
    const git = await containmentDecision(workdir, 'mcp__mycelium__git', { action: 'status' });
    const complete = await containmentDecision(workdir, 'mcp__mycelium__task_complete', { summary: 'done' });
    const failed = await containmentDecision(workdir, 'mcp__mycelium__task_failed', { errorClass: 'x', detail: 'y' });

    expect(sandbox.allow).toBe(true);
    expect(git.allow).toBe(true);
    expect(complete.allow).toBe(true);
    expect(failed.allow).toBe(true);
  });
});

describe('createContainmentHook — the thin SDK adapter', () => {
  let h: TestWorker;

  beforeAll(async () => {
    h = await buildTestWorker();
  });

  afterAll(async () => {
    await h.close();
  });

  it('emits agent.tool_call with is_error:true and no resolved path on denial', async () => {
    const hook = createContainmentHook(h.deps, 'task-1', h.workdir);
    const result = await hook({ tool_name: 'Read', tool_input: { file_path: '/etc/passwd' } });

    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');

    const events = h.broker.ofType('agent.tool_call');
    expect(events).toHaveLength(1);
    expect(events[0]?.taskId).toBe('task-1');
    expect(events[0]?.payload?.is_error).toBe(true);
    expect(events[0]?.payload?.tool).toBe('Read');
    expect(JSON.stringify(events[0]?.payload)).not.toContain(h.workdir);
  });

  it('emits nothing and returns no hookSpecificOutput on allow', async () => {
    const hook = createContainmentHook(h.deps, 'task-2', h.workdir);
    const before = h.broker.events.length;
    const result = await hook({
      tool_name: 'Read',
      tool_input: { file_path: path.join(h.workdir, 'src', 'index.ts') },
    });

    expect(result.hookSpecificOutput).toBeUndefined();
    expect(h.broker.events.length).toBe(before);
  });
});
