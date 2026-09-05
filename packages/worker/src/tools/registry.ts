import type { Deps } from '../deps.js';
import { buildArgChecker } from '../domain/args.js';
import type { ToolDeclaration } from '../transport/transport.js';
import * as complete from './complete.js';
import * as files from './files.js';
import * as git from './git.js';
import * as sandbox from './sandbox.js';

/**
 * The loop's view of the tools. Deliberately narrow: the loop knows that a
 * call produced a result, or that it terminated the task, and nothing about
 * which tool did which. That is what lets `task_complete` be an ordinary tool
 * from the model's side and a loop exit from the host's.
 */

export interface ToolRegistry {
  /** Identical on every turn, so it can sit inside the cached prefix. */
  declarations(): ToolDeclaration[];
  invoke(call: ToolCall): Promise<ToolOutcome>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  taskId: string;
}

export type ToolOutcome =
  /** Goes back to the model as a `tool_result`. `isError` is a result, not an exception. */
  | { kind: 'result'; content: string; isError: boolean; committed?: boolean }
  /** The model called `task_complete`. */
  | { kind: 'complete'; summary: string; commitSha?: string; notes?: string }
  /** The model called `task_failed`. */
  | { kind: 'failed'; errorClass: string; detail: string };

/**
 * The real registry: one list of declarations, one validator compiled from
 * those same schemas, one dispatch table.
 *
 * The order matters. Validation happens before dispatch, always, and a call
 * that fails it comes back as a tool result rather than an exception — the
 * model made a mistake it can correct, and an exception would end the task
 * over a typo. The schema sent to the provider and the schema checked here are
 * the same object, so the declaration and the check cannot drift apart.
 */
export function buildRegistry(deps: Deps): ToolRegistry {
  const declarations: ToolDeclaration[] = [
    sandbox.declaration(),
    ...files.declarations(),
    git.declaration(),
    ...complete.declarations(),
  ];

  const check = buildArgChecker(declarations);

  return {
    declarations: () => declarations,

    async invoke(call: ToolCall): Promise<ToolOutcome> {
      const checked = check(call.name, call.input);
      if (!checked.ok) {
        return { kind: 'result', content: checked.message, isError: true };
      }

      const args = checked.args;

      switch (call.name) {
        case 'sandbox':
          return sandbox.run(deps, args);
        case 'read_file':
          return files.read(deps, args);
        case 'write_file':
          return files.write(deps, args);
        case 'list_files':
          return files.list(deps, args);
        case 'git':
          return git.run(deps, args, call.taskId);
        case 'task_complete':
          return complete.complete(args);
        case 'task_failed':
          return complete.failed(args);
        /* c8 ignore next 2 */
        default:
          return { kind: 'result', content: `no such tool: ${call.name}`, isError: true };
      }
    },
  };
}
