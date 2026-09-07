import { realpath } from 'node:fs/promises';
import path from 'node:path';

/**
 * Workdir containment for the file tools.
 *
 * These tools run on the host, outside the sandbox, so this is the boundary
 * (ticket 0004 section 13, gap 1). Two checks, deliberately separate: a lexical
 * one that needs no filesystem and can therefore be reasoned about on its own,
 * and a filesystem one that catches what lexical resolution cannot — a symlink
 * inside the workdir pointing out of it.
 */

export class PathEscape extends Error {
  constructor(candidate: string, reason: string) {
    // The candidate is echoed because the model needs to know which of its
    // paths was refused; the resolved path is not, because that would hand
    // back the host layout it was trying to reach.
    super(`refusing ${JSON.stringify(candidate)}: ${reason}`);
    this.name = 'PathEscape';
  }
}

const NUL = String.fromCharCode(0);

/**
 * The checks that do not depend on whether the input was relative or
 * absolute: reject the unrepresentable candidate up front, so neither public
 * function has to reason about NUL bytes or empty strings past this point.
 */
function assertWellFormed(candidate: string): void {
  if (candidate.includes(NUL)) {
    throw new PathEscape(candidate, 'a path may not contain a NUL byte');
  }
  if (candidate.trim() === '') {
    throw new PathEscape(candidate, 'a path may not be empty');
  }
}

/**
 * The lexical containment rule shared by both public functions, given a root
 * and a candidate already resolved to an absolute path. Kept as one function
 * so the two callers cannot drift apart.
 */
function assertLexicallyContained(root: string, resolved: string, candidate: string): void {
  // `.git` is inside the checkout and therefore inside these tools' reach, but
  // it is not the model's business: a hook written there is a command that
  // runs on the next commit, and until ticket 0005 the config held the bot
  // token. Matched by whole segment, because `.gitignore` and
  // `.gitattributes` are ordinary files an agent has every reason to edit.
  const segments = path.relative(root, resolved).split(/[\\/]/);
  if (segments.includes('.git')) {
    throw new PathEscape(candidate, 'the .git directory is not readable or writable through these tools');
  }

  // The separator is the point: without it, `/plan/repo-evil` passes a prefix
  // test against `/plan/repo`.
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new PathEscape(candidate, 'that resolves outside the plan checkout');
  }
}

/**
 * The filesystem containment rule shared by both public functions: walk up to
 * the deepest existing ancestor of an already lexically-contained path and
 * resolve it through its symlinks, because the path may legitimately not
 * exist yet — `write_file` creates files. `root` must already be a realpath.
 */
async function assertReallyContained(
  root: string,
  resolved: string,
  candidate: string,
): Promise<string> {
  let existing = resolved;
  const missing: string[] = [];

  // Walk up to the first ancestor that exists. Anything below it cannot be a
  // symlink, because it is not there.
  for (;;) {
    try {
      const real = await realpath(existing);
      const full = missing.length === 0 ? real : path.join(real, ...missing);
      if (full !== root && !full.startsWith(root + path.sep)) {
        throw new PathEscape(candidate, 'that resolves outside the plan checkout');
      }
      return resolved;
    } catch (error) {
      if (error instanceof PathEscape) throw error;
      const parent = path.dirname(existing);
      if (parent === existing) {
        throw new PathEscape(candidate, 'that resolves outside the plan checkout');
      }
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

/**
 * Lexical containment. The contract is workdir-relative, so absolute input is
 * refused outright rather than checked — accepting it would leave containment
 * resting on one comparison instead of two rules.
 */
export function containedPath(workdir: string, candidate: string): string {
  assertWellFormed(candidate);
  if (path.isAbsolute(candidate) || /^[A-Za-z]:/.test(candidate)) {
    throw new PathEscape(candidate, 'paths are relative to the plan checkout');
  }

  const root = path.resolve(workdir);
  const resolved = path.resolve(root, candidate);
  assertLexicallyContained(root, resolved, candidate);

  return resolved;
}

/**
 * Lexical containment, then the same question asked of the filesystem. The
 * deepest existing ancestor is resolved through its symlinks, because the path
 * may legitimately not exist yet — `write_file` creates files.
 */
export async function realContainedPath(workdir: string, candidate: string): Promise<string> {
  const resolved = containedPath(workdir, candidate);
  const root = await realpath(path.resolve(workdir));
  return assertReallyContained(root, resolved, candidate);
}

/**
 * The absolute-input mirror of `containedPath`, for tools that receive
 * already-absolute paths (the SDK's built-in Read/Write/Edit/Glob/Grep — see
 * ticket 12's `PreToolUse` hook). Same three checks as the relative pair:
 * whole-segment `.git` refusal, the `root + path.sep` prefix comparison, and
 * the realpath ancestor walk. The contract is the mirror image of
 * `containedPath`'s: absolute-only, so a relative candidate is refused rather
 * than resolved against some implicit base.
 */
export async function containedAbsolutePath(workdir: string, candidate: string): Promise<string> {
  assertWellFormed(candidate);
  if (!path.isAbsolute(candidate)) {
    throw new PathEscape(candidate, 'this tool requires an absolute path');
  }

  const root = path.resolve(workdir);
  const resolved = path.resolve(candidate);
  assertLexicallyContained(root, resolved, candidate);

  const realRoot = await realpath(root);
  return assertReallyContained(realRoot, resolved, candidate);
}
