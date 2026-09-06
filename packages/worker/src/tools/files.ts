import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Deps } from '../deps.js';
import { PathEscape, realContainedPath } from '../domain/paths.js';
import type { ToolDeclaration } from '../transport/transport.js';
import type { ToolOutcome } from './registry.js';

/**
 * Reading and writing inside the plan checkout, host-side.
 *
 * These are the only tools that touch the host filesystem directly rather than
 * going through the sandbox, which makes `domain/paths.ts` a containment
 * surface rather than a convenience (ticket 0004 section 13, gap 1). Every
 * entry point resolves through it before it opens anything, and the results
 * are bounded because they land in a model context.
 */

export function declarations(): ToolDeclaration[] {
  return [
    {
      name: 'read_file',
      description:
        'Read a file from the plan checkout. Paths are relative to the checkout root; ' +
        'anything outside it is refused.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        properties: {
          path: { type: 'string' },
          max_bytes: { type: 'integer' },
        },
      },
    },
    {
      name: 'write_file',
      description:
        'Write a file in the plan checkout, creating directories as needed. Replaces the ' +
        'whole file; read it first if you mean to change part of it.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'content'],
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
      },
    },
    {
      name: 'list_files',
      description: 'List the entries of a directory in the plan checkout. Defaults to the root.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { path: { type: 'string' } },
      },
    },
  ];
}

export async function read(deps: Deps, raw: Record<string, unknown>): Promise<ToolOutcome> {
  const candidate = raw.path as string;
  const requested = raw.max_bytes as number | undefined;

  // `strict: true` on the declaration rejects `minimum`, so the floor is checked
  // here instead: a zero or negative cap would silently return an empty read.
  if (requested !== undefined && requested < 1) {
    return fail(`max_bytes must be at least 1, got ${requested}`);
  }

  const cap = Math.min(requested ?? Infinity, deps.config.fileReadMaxBytes);

  return guard(candidate, async () => {
    const resolved = await realContainedPath(deps.config.workdir, candidate);
    const buffer = await readFile(resolved);

    if (buffer.byteLength > cap) {
      return ok(
        `${buffer.subarray(0, cap).toString('utf8')}\n\n(${candidate} is ${buffer.byteLength} bytes and has been truncated to ${cap})`,
      );
    }

    return ok(buffer.toString('utf8'));
  });
}

export async function write(deps: Deps, raw: Record<string, unknown>): Promise<ToolOutcome> {
  const candidate = raw.path as string;
  const body = raw.content as string;

  const size = Buffer.byteLength(body, 'utf8');
  if (size > deps.config.fileWriteMaxBytes) {
    // Refused whole rather than written short: a half-written file is worse
    // than no file, because the model will believe the write succeeded.
    return fail(`that is ${size} bytes, past the ${deps.config.fileWriteMaxBytes} byte write cap`);
  }

  return guard(candidate, async () => {
    const resolved = await realContainedPath(deps.config.workdir, candidate);
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, body, 'utf8');
    return ok(`wrote ${size} bytes to ${candidate}`);
  });
}

export async function list(deps: Deps, raw: Record<string, unknown>): Promise<ToolOutcome> {
  const candidate = (raw.path as string | undefined) ?? '.';

  return guard(candidate, async () => {
    const resolved = await realContainedPath(deps.config.workdir, candidate);
    const entries = await readdir(resolved, { withFileTypes: true });
    const cap = deps.config.listFilesMaxEntries;

    const lines = await Promise.all(
      entries.slice(0, cap).map(async (entry) => {
        if (entry.isDirectory()) return `${entry.name}/`;
        const size = await stat(path.join(resolved, entry.name))
          .then((s) => s.size)
          .catch(() => 0);
        return `${entry.name} (${size} bytes)`;
      }),
    );

    if (entries.length > cap) {
      lines.push(`(${entries.length - cap} more entries not listed)`);
    }

    // Relative names only. The host layout is not the model's business.
    return ok(lines.join('\n') || '(empty)');
  });
}

/**
 * One place where a refused path becomes a tool result. The model needs to
 * know which of its paths was rejected and why; it does not need the resolved
 * path, which is exactly what it was reaching for.
 */
async function guard(
  candidate: string,
  body: () => Promise<ToolOutcome>,
): Promise<ToolOutcome> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof PathEscape) return fail(error.message);
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return fail(`${candidate} is not there`);
    if (code === 'EISDIR') return fail(`${candidate} is a directory`);
    if (code === 'ENOTDIR') return fail(`${candidate} is not a directory`);
    return fail(`${candidate}: ${(error as Error).message}`);
  }
}

function ok(content: string): ToolOutcome {
  return { kind: 'result', content, isError: false };
}

function fail(message: string): ToolOutcome {
  return { kind: 'result', content: message, isError: true };
}
