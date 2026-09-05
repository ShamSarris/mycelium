import type { ToolDeclaration } from '../transport/transport.js';
import type { ToolOutcome } from './registry.js';

/**
 * The two tools that end a task.
 *
 * They are ordinary tools from the model's side and a loop exit from the
 * host's, which is the point: the loop ends because the model said so in a
 * structured way, not because it happened to stop calling things. The result
 * the orchestrator stores is then a structured object rather than prose
 * scraped from a final turn.
 */

export function declarations(): ToolDeclaration[] {
  return [
    {
      name: 'task_complete',
      description:
        'End the task successfully. Call this when the work is done and pushed. This is the ' +
        'only way to report success; text alone does not end the task.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['summary'],
        properties: {
          summary: { type: 'string', description: 'What changed, in a few sentences.' },
          commit_sha: { type: 'string', description: 'The last commit this task produced.' },
          notes: { type: 'string', description: 'Anything the next task should know.' },
        },
      },
    },
    {
      name: 'task_failed',
      description:
        'End the task as failed. Call this when the work cannot be done. Failing honestly is ' +
        'better than reporting a success you cannot support; the orchestrator decides what ' +
        'happens next, and you must not retry the task yourself.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['error_class', 'detail'],
        properties: {
          error_class: {
            type: 'string',
            description: 'A short machine-readable class, e.g. compile_error or missing_dependency.',
          },
          detail: { type: 'string', description: 'Enough for someone to act on.' },
        },
      },
    },
  ];
}

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
