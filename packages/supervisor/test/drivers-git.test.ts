import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliGitClient, CloneError } from '../src/drivers/git.js';
import type { ExecResult } from '../src/drivers/exec.js';

/**
 * The clone, tested two ways, because neither alone is honest.
 *
 * A real `file://` remote proves the clone still works — but a file URL cannot
 * carry credentials at all (git rejects them, and `URL` silently drops
 * username and password for that scheme), so it can never show whether the
 * token is being handled correctly. That question is asked at the seam
 * instead, against the `http://` URL a real Gitea would be.
 *
 * The property being protected: `.git` is inside the checkout, the checkout is
 * the agent's file-tool root, and the same tree is mounted into the sandbox. A
 * token in `.git/config` is readable by a prompt-injectable model and by a
 * container that holds no credentials of its own. Ticket 0005 part A.
 */

const run = promisify(execFile);
const TOKEN = 'SECRET-BOT-TOKEN';
const BRANCH = 'plan/018f3a5c';
const HTTP_URL = 'http://gitea.tailnet/mycelium/demo.git';

let root: string;
let remote: string;
let git: CliGitClient;

async function hasGit(): Promise<boolean> {
  try {
    await run('git', ['--version']);
    return true;
  } catch {
    return false;
  }
}

const gitAvailable = await hasGit();

beforeEach(async () => {
  if (!gitAvailable) return;
  root = await mkdtemp(path.join(tmpdir(), 'mycelium-clone-'));
  remote = path.join(root, 'remote.git');

  const seed = path.join(root, 'seed');
  await run('git', ['init', '--bare', `--initial-branch=${BRANCH}`, remote]);
  await run('git', ['init', `--initial-branch=${BRANCH}`, seed]);
  await writeFile(path.join(seed, 'README.md'), 'seeded\n');
  await run('git', ['add', '-A'], { cwd: seed });
  await run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init'], {
    cwd: seed,
  });
  await run('git', ['push', remote, `HEAD:refs/heads/${BRANCH}`], { cwd: seed });

  git = new CliGitClient();
});

afterEach(async () => {
  if (!gitAvailable) return;
  await rm(root, { recursive: true, force: true });
});

function url(): string {
  return pathToFileURL(remote).href;
}

describe.runIf(gitAvailable)('CliGitClient.clone, against a real repository', () => {
  it('checks out the plan branch', async () => {
    const dir = path.join(root, 'work');

    await git.clone({ repoUrl: url(), branch: BRANCH, token: TOKEN, dir });

    expect((await readFile(path.join(dir, 'README.md'), 'utf8')).trim()).toBe('seeded');
    const { stdout } = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir });
    expect(stdout.trim()).toBe(BRANCH);
  });

  it('leaves the remote URL exactly as it was given', async () => {
    const dir = path.join(root, 'work');

    await git.clone({ repoUrl: url(), branch: BRANCH, token: TOKEN, dir });

    const { stdout } = await run('git', ['remote', 'get-url', 'origin'], { cwd: dir });
    expect(stdout.trim()).toBe(url());
  });

  it('still reports a missing branch as a CloneError', async () => {
    const dir = path.join(root, 'work');

    await expect(
      git.clone({ repoUrl: url(), branch: 'plan/does-not-exist', token: TOKEN, dir }),
    ).rejects.toBeInstanceOf(CloneError);
  });

  it('never puts the token in a message it raises', async () => {
    const dir = path.join(root, 'work');

    const error = await git
      .clone({ repoUrl: `${url()}-nope`, branch: BRANCH, token: TOKEN, dir })
      .then(() => null)
      .catch((caught: unknown) => caught as Error);

    expect(error).not.toBeNull();
    expect(error?.message).not.toContain(TOKEN);
  });
});

describe('CliGitClient.clone, at the seam where credentials are handled', () => {
  let calls: Array<{ args: string[]; env: NodeJS.ProcessEnv | undefined }>;

  function capturing(result: Partial<ExecResult> = {}): CliGitClient {
    calls = [];
    return new CliGitClient(120_000, async (_command, args, options) => {
      calls.push({ args, env: options?.env });
      return { code: 0, stdout: '', stderr: '', ...result };
    });
  }

  it('passes the repository URL through untouched', async () => {
    await capturing().clone({ repoUrl: HTTP_URL, branch: BRANCH, token: TOKEN, dir: '/tmp/x' });

    // The URL git records as `origin` is the one it was given, so nothing is
    // written into .git/config that was not already public.
    expect(calls[0]?.args).toContain(HTTP_URL);
  });

  it('puts the token in no argument at all', async () => {
    await capturing().clone({ repoUrl: HTTP_URL, branch: BRANCH, token: TOKEN, dir: '/tmp/x' });

    // Not in the URL, and not in the helper string either — argv is readable
    // by any process of the same user.
    expect(calls[0]?.args.some((arg) => arg.includes(TOKEN))).toBe(false);
  });

  it('hands the token to git through the environment instead', async () => {
    await capturing().clone({ repoUrl: HTTP_URL, branch: BRANCH, token: TOKEN, dir: '/tmp/x' });

    const env = calls[0]?.env ?? {};
    const carried = Object.values(env).some((value) => value === TOKEN);
    expect(carried).toBe(true);
  });

  it('configures a credential helper for this invocation only', async () => {
    await capturing().clone({ repoUrl: HTTP_URL, branch: BRANCH, token: TOKEN, dir: '/tmp/x' });

    const args = calls[0]?.args ?? [];
    // `-c` before the subcommand applies to this run and is not persisted into
    // the new repository's config, which is the whole point.
    const configIndex = args.findIndex((arg) => arg.startsWith('credential.helper='));
    expect(configIndex).toBeGreaterThan(-1);
    expect(args[configIndex - 1]).toBe('-c');
    expect(args.indexOf('clone')).toBeGreaterThan(configIndex);
  });

  it('does not inherit the supervisor is own environment wholesale', async () => {
    process.env.MYCELIUM_UNRELATED_SECRET = 'should-not-travel';
    try {
      await capturing().clone({ repoUrl: HTTP_URL, branch: BRANCH, token: TOKEN, dir: '/tmp/x' });

      // B13: the supervisor's environment holds no secrets for a child to
      // inherit, and this keeps that true by construction rather than by trust.
      expect(calls[0]?.env?.MYCELIUM_UNRELATED_SECRET).toBeUndefined();
    } finally {
      delete process.env.MYCELIUM_UNRELATED_SECRET;
    }
  });
});
