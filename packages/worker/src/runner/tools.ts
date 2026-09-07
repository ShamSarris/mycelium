import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { run as gitRun } from '../tools/git.js';
import { run as sandboxRun } from '../tools/sandbox.js';
import type { CommitBox } from './cadence.js';

/**
 * The worker's tools as an in-process MCP server (ticket 10).
 *
 * The executors are untouched: `sandboxRun` and `gitRun` are the exact
 * functions `tools/sandbox.ts` and `tools/git.ts` export today, imported
 * here rather than reimplemented. Only the declaration and validation layer
 * is new — Zod schemas via `tool()`, consumed by `createSdkMcpServer()`,
 * instead of hand-written JSON Schema declarations checked by `domain/args.ts`'s
 * Ajv compiler. `domain/args.ts` and the JSON-Schema declarations it checked
 * (`tools/registry.ts`, and the `declaration()`/`declarations()` functions
 * `tools/{sandbox,git,complete}.ts` used to export for it) are gone — ticket
 * 14 deleted the host-owned loop that was their only caller.
 *
 * `ToolOutcome` is declared below rather than imported: it used to live in
 * `tools/registry.ts` (this file's own ticket-14 replacement, per that
 * ticket's delete table), and `tools/{sandbox,git,complete}.ts`'s executors
 * still return it, so it moved here with them rather than disappearing.
 *
 * Three of the old seven tools do not appear here: `read_file`, `write_file`,
 * `list_files` are replaced by the Agent SDK's built-in Read/Write/Edit/Glob/
 * Grep (ticket 11), and are deleted in ticket 14.
 *
 * --- The terminal-tool signalling mechanism (read this before ticket 11) ---
 *
 * An MCP tool handler can only return ordinary content to the model — there
 * is no channel back to whatever is driving the SDK's `query()` loop. But
 * `task_complete` / `task_failed` need to end that loop, the same way they
 * ended the old host-owned one.
 *
 * The fix is a small mutable box, `TerminalOutcomeBox`, created once per task
 * by whoever builds the server (`createTerminalOutcomeBox()`) and passed into
 * `buildMyceliumServer(deps, outcomeBox, taskId, commitBox)`. The `task_complete` and
 * `task_failed` handlers write a `TerminalOutcome` into `outcomeBox.outcome`
 * as their *side effect*, and separately return an ordinary, boring
 * `CallToolResult` so the model sees a normal tool result and the SDK's turn
 * loop is never given a reason to think anything failed at the protocol
 * level.
 *
 * Ticket 11's runner owns the box: create it, pass it into this module, drive
 * `query()`, and once the SDK's loop ends (on `end_turn` or any other reason
 * it stops), read `outcomeBox.outcome`:
 *
 *   - non-null `{ kind: 'complete', ... }` → the task succeeded.
 *   - non-null `{ kind: 'failed', ... }`   → the task failed, honestly.
 *   - still `null`                          → the loop ended without either
 *     tool being called. Per the decisions this ticket set inherits ("silence
 *     is never success" — ticket 10 §3), the runner MUST treat this as a
 *     failure. It must not infer success from the SDK simply stopping.
 *
 * The box is intentionally dumb (one field, no events, no queue) because
 * only one terminal call ever matters — the model calling `task_complete`
 * *and then* `task_failed` in the same turn is a model bug, not a case this
 * layer needs to arbitrate; the box just keeps whichever write happened last,
 * and ticket 11 reads it once, after the loop has already ended.
 */

export type TerminalOutcome =
  | { kind: 'complete'; summary: string; commitSha?: string; notes?: string }
  | { kind: 'failed'; errorClass: string; detail: string };

/**
 * What `tools/{sandbox,git,complete}.ts`'s executors return. Moved here from
 * the deleted `tools/registry.ts` (ticket 14) — this file is that module's
 * named replacement. Only the `'result'` arm is ever routed through this
 * module's own `toCallToolResult` (below): `sandboxRun` and `gitRun` never
 * produce the terminal kinds, and `task_complete`/`task_failed` are handled
 * by `TerminalOutcome`/`TerminalOutcomeBox` above instead, not by calling
 * `tools/complete.ts`'s own `complete`/`failed` (which currently have no
 * caller at all — see the ticket 14 completion report).
 */
export type ToolOutcome =
  | { kind: 'result'; content: string; isError: boolean; committed?: boolean }
  | { kind: 'complete'; summary: string; commitSha?: string; notes?: string }
  | { kind: 'failed'; errorClass: string; detail: string };

export interface TerminalOutcomeBox {
  outcome: TerminalOutcome | null;
}

export function createTerminalOutcomeBox(): TerminalOutcomeBox {
  return { outcome: null };
}

/**
 * Wraps a shape in `z.strictObject`, so an unknown key is a validation
 * failure the same way the old JSON Schema's `additionalProperties: false`
 * was — a plain `z.object(shape)` (what `tool()`'s own MCP-side conversion
 * builds from a bare raw shape) silently strips unknown keys instead of
 * rejecting them, which would have quietly dropped the Ajv-era guarantee
 * that a call carrying a property no schema declares is refused.
 *
 * The cast back to `Shape` is what lets a `z.strictObject(...)` — not
 * structurally an `AnyZodRawShape` — satisfy `tool()`'s generic signature
 * while `InferShape<Shape>` still types the handler's `args` correctly; the
 * *runtime* value handed to `tool()`/`createSdkMcpServer()` is the strict
 * schema, which is what actually gets validated (confirmed empirically:
 * MCP's `normalizeObjectSchema` passes an already-constructed Zod object
 * schema through unchanged rather than rebuilding a loose one from it).
 */
function strictShape<Shape extends z.ZodRawShape>(shape: Shape): Shape {
  return z.strictObject(shape) as unknown as Shape;
}

/** Turns the executors' existing `ToolOutcome` into ordinary MCP tool content. */
function toCallToolResult(outcome: ToolOutcome): { content: Array<{ type: 'text'; text: string }>; isError: boolean } {
  /* c8 ignore start -- sandboxRun and gitRun only ever produce 'result'; only complete.ts's
     removed executors produced the terminal kinds, and this module never routes through this
     adapter for task_complete/task_failed. Guarded rather than assumed, so a future change to
     either executor fails loudly instead of silently mis-rendering. */
  if (outcome.kind !== 'result') {
    throw new Error(`internal error: unexpected non-result tool outcome (${outcome.kind})`);
  }
  /* c8 ignore stop */
  return { content: [{ type: 'text', text: outcome.content }], isError: outcome.isError };
}

function buildSandboxTool(deps: Deps) {
  return tool(
    'sandbox',
    'Run a command in an isolated container with the plan checkout mounted at /workspace. ' +
      'This is how you build, test, and run anything. The container has no route to the ' +
      'internet except the plan allowlist, and it holds no credentials.',
    strictShape({
      image: z.string().describe('A container image from the node allowlist.'),
      cmd: z
        .array(z.string())
        .min(1)
        .describe(
          'Argv, at least one element. Not a shell string; use ["sh", "-lc", "..."] if you want a shell.',
        ),
      env: z
        .array(z.strictObject({ name: z.string(), value: z.string() }))
        .optional()
        .describe(
          'Extra environment, as {name, value} pairs. Never credentials; the container is not trusted with them.',
        ),
      network: z
        .boolean()
        .optional()
        .describe('Attach the plan network, reaching only the plan allowlist through a proxy.'),
      timeout_sec: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Wall-clock kill after this many seconds; must be positive.'),
    }),
    async (args) => toCallToolResult(await sandboxRun(deps, args)),
  );
}

/**
 * The `commitBox` is the second use of the same signalling pattern: `gitRun`
 * already reports `committed: true` on a successful commit, and the
 * commit-cadence instrument in `runner/cadence.ts` needs to know about it,
 * but a tool handler has no channel back to the runner driving `query()`.
 * Recording it here — before the tool result is returned, and therefore
 * before that result ever reaches the runner — is what gives the counter its
 * ordering guarantee.
 */
function buildGitTool(deps: Deps, taskId: string, commitBox: CommitBox) {
  return tool(
    'git',
    'Commit and push your work on the plan branch. Commit at every checkpoint and push ' +
      'often: work that is not pushed does not survive the environment being torn down.',
    strictShape({
      action: z.enum(['commit', 'push', 'status', 'diff']),
      message: z.string().optional().describe('Required for commit. Say why, not what.'),
      branch: z.string().optional().describe('Only the plan branch is allowed.'),
    }),
    async (args) => {
      const outcome = await gitRun(deps, args, taskId);
      if (outcome.kind === 'result' && outcome.committed === true) commitBox.commits += 1;
      return toCallToolResult(outcome);
    },
  );
}

function buildTaskCompleteTool(outcomeBox: TerminalOutcomeBox) {
  return tool(
    'task_complete',
    'End the task successfully. Call this when the work is done and pushed. This is the ' +
      'only way to report success; text alone does not end the task.',
    strictShape({
      summary: z.string().describe('What changed, in a few sentences.'),
      commit_sha: z.string().optional().describe('The last commit this task produced.'),
      notes: z.string().optional().describe('Anything the next task should know.'),
    }),
    async (args) => {
      outcomeBox.outcome = {
        kind: 'complete',
        summary: args.summary,
        ...(args.commit_sha === undefined ? {} : { commitSha: args.commit_sha }),
        ...(args.notes === undefined ? {} : { notes: args.notes }),
      };
      return { content: [{ type: 'text', text: 'Recorded: task complete.' }], isError: false };
    },
  );
}

function buildTaskFailedTool(outcomeBox: TerminalOutcomeBox) {
  return tool(
    'task_failed',
    'End the task as failed. Call this when the work cannot be done. Failing honestly is ' +
      'better than reporting a success you cannot support; the orchestrator decides what ' +
      'happens next, and you must not retry the task yourself.',
    strictShape({
      error_class: z
        .string()
        .describe('A short machine-readable class, e.g. compile_error or missing_dependency.'),
      detail: z.string().describe('Enough for someone to act on.'),
    }),
    async (args) => {
      outcomeBox.outcome = { kind: 'failed', errorClass: args.error_class, detail: args.detail };
      return { content: [{ type: 'text', text: 'Recorded: task failed.' }], isError: false };
    },
  );
}

/**
 * Builds the in-process MCP server ticket 11's runner passes to `query()`.
 * Built fresh per task (like the old `buildRegistry(deps)` — see
 * `runner/host-loop.ts`) so `outcomeBox` and the closed-over `taskId` cannot
 * leak from one task into the next.
 */
export function buildMyceliumServer(
  deps: Deps,
  outcomeBox: TerminalOutcomeBox,
  taskId: string,
  commitBox: CommitBox,
) {
  return createSdkMcpServer({
    name: 'mycelium',
    version: '1.0.0',
    tools: [
      buildSandboxTool(deps),
      buildGitTool(deps, taskId, commitBox),
      buildTaskCompleteTool(outcomeBox),
      buildTaskFailedTool(outcomeBox),
    ],
  });
}
