import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PathEscape, containedAbsolutePath, containedPath, realContainedPath } from '../../src/domain/paths.js';

/**
 * The file tools run on the host, outside the sandbox, so this is a containment
 * surface rather than a convenience (ticket 0004 section 13, gap 1). A bug here
 * reaches the host filesystem, not a container, which is why each escape is
 * tested individually rather than as one happy-path assertion.
 */

const NUL = String.fromCharCode(0);

let root: string;
let workdir: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'mycelium-paths-'));
  workdir = path.join(root, 'repo');
  await mkdir(path.join(workdir, 'src'), { recursive: true });
  await writeFile(path.join(workdir, 'src', 'index.ts'), 'export {};\n');

  // A sibling whose name starts with the workdir's. A prefix comparison that
  // forgot the separator would let this through.
  await mkdir(path.join(root, 'repo-evil'), { recursive: true });
  await writeFile(path.join(root, 'repo-evil', 'secret'), 'token\n');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('containedPath', () => {
  it('resolves a legitimate nested path', () => {
    expect(containedPath(workdir, 'src/index.ts')).toBe(path.join(workdir, 'src', 'index.ts'));
  });

  it('resolves the workdir itself', () => {
    expect(containedPath(workdir, '.')).toBe(workdir);
  });

  it('rejects a traversal out of the workdir', () => {
    expect(() => containedPath(workdir, '../repo-evil/secret')).toThrow(PathEscape);
    expect(() => containedPath(workdir, 'src/../../outside')).toThrow(PathEscape);
  });

  it('rejects an absolute path, even one that happens to be inside', () => {
    // The tool contract is workdir-relative. Accepting absolute input would
    // make the containment check the only thing between a model and the host
    // filesystem, rather than the second of two rules.
    expect(() => containedPath(workdir, path.join(workdir, 'src', 'index.ts'))).toThrow(PathEscape);
    expect(() => containedPath(workdir, '/etc/passwd')).toThrow(PathEscape);
  });

  it('rejects a sibling directory that merely shares the workdir prefix', () => {
    expect(() => containedPath(workdir, '../repo-evil/secret')).toThrow(PathEscape);
  });

  it('rejects a path with a NUL byte rather than letting the syscall decide', () => {
    expect(() => containedPath(workdir, `src/index${NUL}.ts`)).toThrow(PathEscape);
  });

  it('refuses anything under .git, wherever it appears in the path', () => {
    // The bot token is no longer written there (ticket 0005 part A), but .git
    // is not the model's business either way, and a hook it could write is a
    // command that runs on the next commit.
    expect(() => containedPath(workdir, '.git/config')).toThrow(PathEscape);
    expect(() => containedPath(workdir, '.git')).toThrow(PathEscape);
    expect(() => containedPath(workdir, 'src/.git/config')).toThrow(PathEscape);
    expect(() => containedPath(workdir, '.git/hooks/pre-commit')).toThrow(PathEscape);
  });

  it('does not refuse names that merely start with .git', () => {
    // A prefix match here would be its own small bug: .gitignore and
    // .gitattributes are ordinary files an agent has every reason to edit.
    expect(containedPath(workdir, '.gitignore')).toBe(path.join(workdir, '.gitignore'));
    expect(containedPath(workdir, 'src/.gitattributes')).toBe(
      path.join(workdir, 'src', '.gitattributes'),
    );
    expect(containedPath(workdir, 'src/git.ts')).toBe(path.join(workdir, 'src', 'git.ts'));
  });

  it('names the offending path in the error, without leaking the resolved one', () => {
    expect(() => containedPath(workdir, '../outside')).toThrow(/\.\.\/outside/);
  });
});

describe('realContainedPath', () => {
  it('accepts a real file inside the workdir', async () => {
    await expect(realContainedPath(workdir, 'src/index.ts')).resolves.toBe(
      path.join(workdir, 'src', 'index.ts'),
    );
  });

  it('accepts a path that does not exist yet, so write_file can create one', async () => {
    await expect(realContainedPath(workdir, 'src/new.ts')).resolves.toBe(
      path.join(workdir, 'src', 'new.ts'),
    );
  });

  it('rejects a symlink planted inside the workdir that points outside it', async () => {
    const link = path.join(workdir, 'escape');
    // Windows needs an explicit junction for a directory link; POSIX does not.
    await symlink(path.join(root, 'repo-evil'), link, 'junction').catch(async () => {
      await symlink(path.join(root, 'repo-evil'), link);
    });

    await expect(realContainedPath(workdir, 'escape/secret')).rejects.toThrow(PathEscape);
  });
});

describe('containedAbsolutePath', () => {
  // Ticket 12 installs a PreToolUse hook that receives absolute paths from the
  // SDK built-in tools, so this is the mirror of containedPath: same three
  // checks (paths.ts 50-53 whole-segment .git refusal, 57-59 root+sep prefix,
  // 69-96 realpath ancestor walk), but the contract is absolute-only rather
  // than relative-only.

  it('resolves an absolute path inside the workdir', async () => {
    await expect(
      containedAbsolutePath(workdir, path.join(workdir, 'src', 'index.ts')),
    ).resolves.toBe(path.join(workdir, 'src', 'index.ts'));
  });

  it('resolves an absolute path inside a nested existing directory', async () => {
    await expect(containedAbsolutePath(workdir, path.join(workdir, 'src'))).resolves.toBe(
      path.join(workdir, 'src'),
    );
  });

  it('resolves an absolute path to a file that does not exist yet, inside the workdir', async () => {
    await expect(
      containedAbsolutePath(workdir, path.join(workdir, 'src', 'new-abs.ts')),
    ).resolves.toBe(path.join(workdir, 'src', 'new-abs.ts'));
  });

  it('rejects an absolute path outside the workdir', async () => {
    await expect(containedAbsolutePath(workdir, '/etc/passwd')).rejects.toThrow(PathEscape);
  });

  it('names the candidate, not the resolved path, when refusing /etc/passwd', async () => {
    await expect(containedAbsolutePath(workdir, '/etc/passwd')).rejects.toThrow(/\/etc\/passwd/);
  });

  it('rejects the sibling-prefix trick', async () => {
    // workdir is .../repo, candidate is .../repo-evil/secret. Without the
    // root+separator comparison, repo-evil would pass a prefix test.
    await expect(
      containedAbsolutePath(workdir, path.join(root, 'repo-evil', 'secret')),
    ).rejects.toThrow(PathEscape);
  });

  it('resolves a path that traverses out and back in, when it genuinely lands inside', async () => {
    // Built by concatenation, not path.join, so the literal ".." segment
    // reaches containedAbsolutePath instead of being normalized away first.
    const candidate = `${workdir}${path.sep}..${path.sep}${path.basename(workdir)}${path.sep}ok.txt`;
    await expect(containedAbsolutePath(workdir, candidate)).resolves.toBe(
      path.join(workdir, 'ok.txt'),
    );
  });

  it('rejects a path that traverses out of the workdir', async () => {
    const candidate = `${workdir}${path.sep}..${path.sep}..${path.sep}etc${path.sep}passwd`;
    await expect(containedAbsolutePath(workdir, candidate)).rejects.toThrow(PathEscape);
  });

  it('rejects a symlink planted inside the workdir that points outside it', async () => {
    const link = path.join(workdir, 'escape-abs');
    await symlink(path.join(root, 'repo-evil'), link, 'junction').catch(async () => {
      await symlink(path.join(root, 'repo-evil'), link);
    });

    await expect(containedAbsolutePath(workdir, path.join(link, 'secret'))).rejects.toThrow(
      PathEscape,
    );
  });

  it('refuses anything under .git, wherever it appears in the path', async () => {
    await expect(
      containedAbsolutePath(workdir, path.join(workdir, '.git', 'config')),
    ).rejects.toThrow(PathEscape);
    await expect(containedAbsolutePath(workdir, path.join(workdir, '.git'))).rejects.toThrow(
      PathEscape,
    );
    await expect(
      containedAbsolutePath(workdir, path.join(workdir, 'src', '.git', 'config')),
    ).rejects.toThrow(PathEscape);
  });

  it('does not refuse names that merely start with .git', async () => {
    await expect(containedAbsolutePath(workdir, path.join(workdir, '.gitignore'))).resolves.toBe(
      path.join(workdir, '.gitignore'),
    );
    await expect(
      containedAbsolutePath(workdir, path.join(workdir, 'src', '.gitattributes')),
    ).resolves.toBe(path.join(workdir, 'src', '.gitattributes'));
  });

  it('rejects a relative path, the mirror of the existing contract', async () => {
    await expect(containedAbsolutePath(workdir, 'src/index.ts')).rejects.toThrow(PathEscape);
  });

  it('rejects a path with a NUL byte', async () => {
    const candidate = `${path.join(workdir, 'src', 'index')}${NUL}.ts`;
    await expect(containedAbsolutePath(workdir, candidate)).rejects.toThrow(PathEscape);
  });

  it('rejects an empty candidate', async () => {
    await expect(containedAbsolutePath(workdir, '')).rejects.toThrow(PathEscape);
  });

  it('rejects a whitespace-only candidate', async () => {
    await expect(containedAbsolutePath(workdir, '   ')).rejects.toThrow(PathEscape);
  });

  it('resolves the workdir itself', async () => {
    await expect(containedAbsolutePath(workdir, workdir)).resolves.toBe(workdir);
  });

  it.runIf(process.platform === 'win32')(
    'rejects a drive-letter path outside the workdir, on Windows',
    async () => {
      await expect(
        containedAbsolutePath(workdir, 'C:\\Windows\\System32\\drivers\\etc\\hosts'),
      ).rejects.toThrow(PathEscape);
    },
  );
});
