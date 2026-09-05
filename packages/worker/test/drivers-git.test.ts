import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliGitClient } from '../src/drivers/git.js';
import { BranchNotAllowed } from '../src/tools/git.js';

/**
 * The real git client, against a real repository. Everything else in this
 * package is tested against a fake, but git's behaviour — what counts as
 * clean, what "nothing to commit" looks like, what it writes to stderr — is
 * precisely the part a fake would get wrong.
 */

const run = promisify(execFile);
const BRANCH = 'plan/018f3a5c';
const TOKEN = 'SECRET-BOT-TOKEN';

let root: string;
let workdir: string;
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
  root = await mkdtemp(path.join(tmpdir(), 'mycelium-git-'));
  workdir = path.join(root, 'repo');
  remote = path.join(root, 'remote.git');

  await run('git', ['init', '--bare', '--initial-branch=main', remote]);
  await run('git', ['init', `--initial-branch=${BRANCH}`, workdir]);
  await run('git', ['remote', 'add', 'origin', remote], { cwd: workdir });
  await writeFile(path.join(workdir, 'README.md'), 'start\n');
  await run('git', ['add', '-A'], { cwd: workdir });
  await run(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'initial'],
    { cwd: workdir },
  );

  git = new CliGitClient(workdir, BRANCH, TOKEN);
});

afterEach(async () => {
  if (!gitAvailable) return;
  await rm(root, { recursive: true, force: true });
});

describe.runIf(gitAvailable)('CliGitClient', () => {
  it('commits everything in the tree and returns the SHA', async () => {
    await writeFile(path.join(workdir, 'src.ts'), 'export {};\n');

    const sha = await git.commit('Add the module');

    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await git.head()).toBe(sha);
  });

  it('returns null rather than a SHA when there was nothing to commit', async () => {
    // Reported honestly: a model that believes it committed will not commit
    // again, and the work would be lost at teardown.
    expect(await git.commit('nothing changed')).toBeNull();
  });

  it('authors the commit as the plan agent', async () => {
    await writeFile(path.join(workdir, 'src.ts'), 'export {};\n');
    await git.commit('Add the module');

    const { stdout } = await run('git', ['log', '-1', '--format=%an <%ae>'], { cwd: workdir });
    expect(stdout.trim()).toBe('mycelium plan agent <plan-agent@mycelium.local>');
  });

  it('reports what changed, by path', async () => {
    await writeFile(path.join(workdir, 'a.ts'), 'export {};\n');

    const status = await git.status();

    expect(status.clean).toBe(false);
    expect(status.changed).toContain('a.ts');
    expect(status.branch).toBe(BRANCH);
  });

  it('reports a clean tree as clean', async () => {
    expect((await git.status()).clean).toBe(true);
  });

  it('diffs staged changes as well as unstaged ones', async () => {
    await writeFile(path.join(workdir, 'README.md'), 'changed\n');
    await run('git', ['add', '-A'], { cwd: workdir });

    // `commit` stages everything, so a diff that only showed the working tree
    // would go blank at exactly the moment the model wanted to look.
    expect(await git.diff()).toContain('changed');
  });

  it('pushes the plan branch to the remote', async () => {
    await writeFile(path.join(workdir, 'src.ts'), 'export {};\n');
    const sha = await git.commit('Add the module');

    await git.push(BRANCH);

    const { stdout } = await run('git', ['rev-parse', `refs/heads/${BRANCH}`], { cwd: remote });
    expect(stdout.trim()).toBe(sha);
  });

  it('refuses to push anything else', async () => {
    await expect(git.push('main')).rejects.toBeInstanceOf(BranchNotAllowed);
  });

  it('leaves no credential in the repository after a push', async () => {
    await writeFile(path.join(workdir, 'src.ts'), 'export {};');
    await git.commit('Add the module');

    await git.push(BRANCH);

    // The exposure ticket 0005 closed: .git is inside the file tools' root and
    // inside the tree mounted into the sandbox.
    const config = await readFile(path.join(workdir, '.git', 'config'), 'utf8');
    expect(config).not.toContain(TOKEN);
    expect(config).not.toContain('x-access-token');
  });

  it('keeps the token out of a failure message, which goes to the model', async () => {
    await run('git', ['remote', 'set-url', 'origin', path.join(root, 'nowhere.git')], {
      cwd: workdir,
    });

    const error = await git
      .push(BRANCH)
      .then(() => null)
      .catch((caught: unknown) => caught as Error);

    expect(error).not.toBeNull();
    expect(error?.message).not.toContain(TOKEN);
  });

  it('names the subcommand in a failure, not the -c flag in front of it', async () => {
    await run('git', ['remote', 'set-url', 'origin', path.join(root, 'nowhere.git')], {
      cwd: workdir,
    });

    const error = await git
      .push(BRANCH)
      .then(() => null)
      .catch((caught: unknown) => caught as Error);

    expect(error?.message).toContain('git push failed');
  });

  it('reports a git failure with what git actually said', async () => {
    await run('git', ['remote', 'set-url', 'origin', path.join(root, 'nowhere.git')], {
      cwd: workdir,
    });

    await expect(git.push(BRANCH)).rejects.toThrow(/git push failed/);
  });
});
