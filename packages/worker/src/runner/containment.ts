import path from 'node:path';
import type { Deps } from '../deps.js';
import { PathEscape, containedAbsolutePath, realContainedPath } from '../domain/paths.js';

/**
 * The `PreToolUse` containment hook (ticket 12).
 *
 * Ticket 11 enabled the Agent SDK's built-in `Read`/`Write`/`Edit`/`Glob`/
 * `Grep` tools. Those run as the agent process user, on a host with no
 * containment of their own — `domain/paths.ts` (ticket 02) built the checks;
 * this module wires them into the one place the SDK lets a host deny a tool
 * call before it runs.
 *
 * Deliberately structural rather than typed against the real Agent SDK's own
 * hook types, for the same reason `runner/events.ts` is structural: this file
 * must never import `@anthropic-ai/claude-agent-sdk` — `runner/agent-sdk.ts`
 * is the only file this ticket set permits to do that (ticket 11 §3; ticket
 * 14 adds the guard test). `createContainmentHook`'s return type only needs
 * the one field (`hookSpecificOutput`) the SDK's own `PreToolUseHookInput`/
 * `SyncHookJSONOutput` actually define for this purpose — a real SDK value
 * satisfies it structurally, and `agent-sdk.ts` casts across the boundary the
 * same way it already does for `mapSdkMessage`.
 *
 * 01-findings.md Q4 is UNRESOLVED, not PASS: the hook shape and deny
 * capability are confirmed only from the SDK's shipped `.d.ts`, never
 * observed against a live, completing run from inside this session. Per the
 * ticket's Q4-UNRESOLVED row, this hook is built to the documented shape and
 * covered by unit tests here, but `test/integration/live-model.test.ts` adds
 * a `WORKER_LIVE_TESTS=1`-gated live check of the two things a `.d.ts` cannot
 * prove: that `file_path` truly arrives absolute, and that a `deny` decision
 * truly stops the call. This ticket does not run that live test.
 */

export type ContainmentResult = { allow: true } | { allow: false; reason: string };

/**
 * Tools whose input carries a single required absolute path, in the field
 * named here — the SDK's own `FileReadInput`/`FileEditInput`/`FileWriteInput`
 * (`01-findings.md` Q4, quoted from `sdk-tools.d.ts`) all name it `file_path`
 * and document it as absolute.
 */
const FILE_PATH_TOOLS = new Set(['Read', 'Write', 'Edit']);

/**
 * Tools whose input carries an *optional* `path`, not documented
 * absolute-only the way `file_path` is (`01-findings.md` Q4's gap finding).
 * `GlobInput`/`GrepInput` both name it `path`.
 */
const SEARCH_PATH_TOOLS = new Set(['Glob', 'Grep']);

/**
 * The worker's own MCP tools (`runner/tools.ts`), plus the SDK's built-in
 * `Agent` tool (ticket 13). None of these are file tools — the hook has no
 * path to check for them. The MCP tools already have their own containment
 * (the `git` driver's own scoping, the sandbox's gVisor boundary) that
 * ticket 12 explicitly does not touch; `Agent`'s containment is structural
 * rather than a path check, ticket 13 §6.2's own reasoning: a subagent's
 * `tools` can only ever be drawn from this same session's own `tools` list
 * (the Agent SDK docs describe subagents as inheriting "the built-in tools
 * ... available in the main conversation" — i.e. bounded by this file's
 * sibling `agent-sdk.ts`'s own `tools`/`allowedTools`, never wider than it),
 * and every one of *those* file-tool calls — whether issued by the main
 * agent or from inside a subagent's own execution — passes back through
 * this exact hook, since `AgentDefinition` carries no `hooks` field of its
 * own to opt out with. Listed explicitly so `Agent` is allowed *by policy*,
 * not by falling through a check that never ran for it — the same
 * reasoning the MCP tools below already use.
 */
const PASSTHROUGH_TOOLS = new Set([
  'mcp__mycelium__sandbox',
  'mcp__mycelium__git',
  'mcp__mycelium__task_complete',
  'mcp__mycelium__task_failed',
  'Agent',
]);

/**
 * The pure decision function (§6.2). No SDK, no subprocess, no network — just
 * `workdir`, the tool name, and its raw input, so `test/runner/containment.test.ts`
 * can exercise every case against a real filesystem fixture without a live
 * model call.
 */
export async function containmentDecision(
  workdir: string,
  toolName: string,
  input: unknown,
): Promise<ContainmentResult> {
  if (PASSTHROUGH_TOOLS.has(toolName)) {
    return { allow: true };
  }

  if (FILE_PATH_TOOLS.has(toolName)) {
    const filePath = readStringField(input, 'file_path');
    if (filePath === undefined) {
      return { allow: false, reason: `${toolName} call carried no file_path to check` };
    }
    return checkAbsolute(workdir, filePath);
  }

  if (SEARCH_PATH_TOOLS.has(toolName)) {
    const searchPath = readStringField(input, 'path');

    // 01-findings.md Q4, confirmed live: an omitted Glob/Grep `path` arrives
    // *absent*, not merely possibly-relative, and the tool then searches
    // from the query's own `cwd`. `agent-sdk.ts` always sets `cwd:
    // config.workdir`, so an absent path already means "search the
    // checkout" — decision (b) from the ticket's gate note: treat that
    // explicitly as workdir rather than trusting the tool's own default to
    // stay put.
    if (searchPath === undefined) {
      return { allow: true };
    }

    // Decision (a): a *present* relative path is resolved against workdir
    // before the containment check, reusing the existing relative-path
    // primitive (`realContainedPath`, ticket 02) rather than writing a
    // second implementation of the same rule.
    return path.isAbsolute(searchPath)
      ? checkAbsolute(workdir, searchPath)
      : checkRelative(workdir, searchPath);
  }

  // Fail closed (§6.1's unknown-tool case): a tool name this hook does not
  // recognize gets no path check at all, so it must not be allowed through
  // by a default that assumes "no rule" means "no problem".
  return { allow: false, reason: `containment: no rule for tool "${toolName}"; denying by default` };
}

function readStringField(input: unknown, field: string): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const value = (input as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}

async function checkAbsolute(workdir: string, candidate: string): Promise<ContainmentResult> {
  try {
    await containedAbsolutePath(workdir, candidate);
    return { allow: true };
  } catch (error) {
    return { allow: false, reason: denyReason(error, candidate) };
  }
}

async function checkRelative(workdir: string, candidate: string): Promise<ContainmentResult> {
  try {
    await realContainedPath(workdir, candidate);
    return { allow: true };
  } catch (error) {
    return { allow: false, reason: denyReason(error, candidate) };
  }
}

/**
 * `PathEscape.message` already echoes the candidate only, never the resolved
 * path (`domain/paths.ts`) — decision 3 in this ticket. Anything other than
 * `PathEscape` is not expected (`containedAbsolutePath`/`realContainedPath`
 * only ever throw it), but denies rather than rethrows if it ever happens: a
 * containment check that can crash the hook and fall back to "no opinion"
 * would be worse than one that denies loudly.
 */
function denyReason(error: unknown, candidate: string): string {
  if (error instanceof PathEscape) return error.message;
  return `refusing ${JSON.stringify(candidate)}: containment check failed`;
}

/** The minimal shape this hook reads off the SDK's `PreToolUseHookInput`. */
export interface ContainmentHookInput {
  tool_name: string;
  tool_input: unknown;
}

/** The minimal shape this hook returns, matching `SyncHookJSONOutput`. */
export interface ContainmentHookResult {
  hookSpecificOutput?: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'deny';
    permissionDecisionReason: string;
  };
}

/**
 * The thin SDK adapter (§6.2/§6.3): runs the pure decision, and on denial
 * emits the event an operator needs to see a containment refusal happen
 * (decision 3) before turning it into the hook's own deny output. Allows are
 * silent — the hook denies, it does not rewrite, redirect, or narrate an
 * allow (decision 3) — so `permissionMode: 'dontAsk'` plus `allowedTools`
 * (already set in `agent-sdk.ts`) is what actually lets the call through.
 */
export function createContainmentHook(
  deps: Pick<Deps, 'broker'>,
  taskId: string,
  workdir: string,
): (input: ContainmentHookInput) => Promise<ContainmentHookResult> {
  return async (input) => {
    const decision = await containmentDecision(workdir, input.tool_name, input.tool_input);
    if (decision.allow) {
      return {};
    }

    // The payload names the tool and the refusal reason (which itself only
    // ever names the candidate, never the resolved path) — never the
    // resolved path directly.
    await deps.broker.emit({
      type: 'agent.tool_call',
      severity: 'warn',
      taskId,
      payload: { tool: input.tool_name, outcome: 'containment_denied', is_error: true, reason: decision.reason },
    });

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: decision.reason,
      },
    };
  };
}
