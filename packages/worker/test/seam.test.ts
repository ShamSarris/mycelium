import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Ticket 11 confined every import of the Agent SDK to exactly two files:
 * `runner/agent-sdk.ts` (the `TaskRunner` that drives `query()`) and
 * `runner/tools.ts` (the in-process MCP server ticket 10 built with the
 * SDK's own `tool()`/`createSdkMcpServer()`). Both are legitimate — the
 * runner needs the SDK to run a task at all, and the tool declarations need
 * its own MCP helpers — but nowhere else in the package may import it: that
 * is what keeps every other module speaking the package's own seams
 * (`TaskRunner`, `ToolOutcome`, `Deps`) instead of the SDK's vocabulary, and
 * it is what lets `runner/containment.ts` stay structural (see its own
 * header comment) rather than typed against the real SDK's hook types.
 *
 * This inverts what `test/transport.test.ts` used to assert about
 * `@anthropic-ai/sdk` before ticket 14 deleted it along with the host-owned
 * loop it drove — the discipline is worth more now, not less, with a real
 * agent framework behind the seam instead of a hand-rolled one.
 *
 * The check looks for a real `import ... from '@anthropic-ai/claude-agent-sdk'`
 * (or an equivalent dynamic `import()`/`require()`), not a bare substring
 * match: `runner/containment.ts`'s own header comment *names* the package,
 * to explain why that file must never import it, and a naive substring
 * check would misfire on that mention and report three offenders instead of
 * the two real ones.
 */

const PACKAGE = '@anthropic-ai/claude-agent-sdk';
const REAL_IMPORT = new RegExp(
  `(?:from\\s+|require\\(|import\\()\\s*['"]${PACKAGE.replace(/[/.]/g, '\\$&')}['"]`,
);
const EXPECTED = [path.join('runner', 'agent-sdk.ts'), path.join('runner', 'tools.ts')].sort();

describe('the seam itself', () => {
  it(`imports ${PACKAGE} in exactly runner/agent-sdk.ts and runner/tools.ts, nowhere else`, async () => {
    const srcRoot = path.join(import.meta.dirname, '..', 'src');
    const importers: string[] = [];

    async function walk(dir: string): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.name.endsWith('.ts')) {
          const source = await readFile(full, 'utf8');
          if (REAL_IMPORT.test(source)) {
            importers.push(path.relative(srcRoot, full));
          }
        }
      }
    }

    await walk(srcRoot);

    // The seam is only worth having if it holds. This is the assertion that
    // keeps a convenient import from quietly dissolving it.
    expect(importers.sort()).toEqual(EXPECTED);
  });
});
