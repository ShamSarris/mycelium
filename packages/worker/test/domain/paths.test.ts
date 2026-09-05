import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PathEscape, containedPath, realContainedPath } from '../../src/domain/paths.js';

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
