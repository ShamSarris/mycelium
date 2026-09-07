import type { ToolOutcome } from '../runner/tools.js';

/**
 * The two tools that end a task.
 *
 * They are ordinary tools from the model's side and a loop exit from the
 * host's, which is the point: the loop ends because the model said so in a
 * structured way, not because it happened to stop calling things. The result
 * the orchestrator stores is then a structured object rather than prose
 * scraped from a final turn.
 *
 * Ticket 14: the JSON-Schema `declarations()` this file used to export were
 * deleted with `tools/registry.ts`, their only caller — `runner/tools.ts`
 * declares the `task_complete`/`task_failed` MCP tools directly with Zod
 * (ticket 10) and does not call these functions either; they are kept only
 * because the ticket's own delete table names this file a survivor. See the
 * completion report for why that survives despite having no current caller.
 */

export function complete(raw: Record<string, unknown>): ToolOutcome {
  const commitSha = raw.commit_sha as string | undefined;
  const notes = raw.notes as string | undefined;

  return {
    kind: 'complete',
    summary: raw.summary as string,
    ...(commitSha === undefined ? {} : { commitSha }),
    ...(notes === undefined ? {} : { notes }),
  };
}

export function failed(raw: Record<string, unknown>): ToolOutcome {
  return {
    kind: 'failed',
    errorClass: raw.error_class as string,
    detail: raw.detail as string,
  };
}
