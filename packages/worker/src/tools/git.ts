import type { Deps } from '../deps.js';
import type { ToolDeclaration } from '../transport/transport.js';
import type { ToolOutcome } from './registry.js';

/**
 * Git runs host-side, in this process, because it holds the Gitea bot token
 * and baseline section 7 forbids that token entering a sandbox. The clone
 * already carries it in `.git/config` inside the environment (ticket 0003
 * gap 6), so this is where the credential already lives, not a new exposure.
 */
export interface GitClient {
  /** Stages everything under the workdir and commits. Null when there was nothing to commit. */
  commit(message: string): Promise<string | null>;
  /** Pushes the plan branch. Refuses any other branch, agent-side and again at Gitea. */
  push(branch: string): Promise<void>;
  status(): Promise<GitStatus>;
  diff(): Promise<string>;
  head(): Promise<string>;
}

export interface GitStatus {
  branch: string;
  clean: boolean;
  /** Paths, relative to the workdir. Never contents. */
  changed: string[];
}

/** A push aimed anywhere but the plan's own branch. */
export class BranchNotAllowed extends Error {
  constructor(branch: string, allowed: string) {
    super(`refusing to push ${branch}; this agent may push ${allowed} only`);
    this.name = 'BranchNotAllowed';
  }
}

const ACTIONS = ['commit', 'push', 'status', 'diff'] as const;

export function declaration(): ToolDeclaration {
  return {
    name: 'git',
    description:
      'Commit and push your work on the plan branch. Commit at every checkpoint and push ' +
      'often: work that is not pushed does not survive the environment being torn down.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: [...ACTIONS] },
        message: { type: 'string', description: 'Required for commit. Say why, not what.' },
        branch: { type: 'string', description: 'Only the plan branch is allowed.' },
      },
    },
  };
}

/**
 * The commit SHA goes into the event as well as the tool result, which is what
 * makes git history and the event log joinable (archive T10). The event is
 * emitted here rather than by the loop because only this tool knows the SHA.
 */
export async function run(
  deps: Deps,
  raw: Record<string, unknown>,
  taskId: string,
): Promise<ToolOutcome> {
  const action = raw.action as (typeof ACTIONS)[number];

  try {
    switch (action) {
      case 'commit': {
        const message = raw.message as string | undefined;
        if (message === undefined || message.trim() === '') {
          return fail('a commit needs a message');
        }

        const sha = await deps.git.commit(message);
        await deps.broker.emit({
          type: 'agent.tool_call',
          taskId,
          payload: {
            tool: 'git',
            action: 'commit',
            ...(sha === null ? {} : { commit_sha: sha }),
          },
        });

        // Reported honestly rather than as a success with an invented SHA: a
        // model that believes it committed will not commit again.
        return sha === null
          ? ok('there was nothing to commit')
          : { kind: 'result', content: `committed ${sha}`, isError: false, committed: true };
      }

      case 'push': {
        const branch = (raw.branch as string | undefined) ?? deps.config.branch;
        if (branch !== deps.config.branch) {
          // Gitea's protected branches would refuse this too (D19). Refusing
          // here makes it a legible tool result rather than a git error.
          return fail(`this agent may push ${deps.config.branch} only, not ${branch}`);
        }

        await deps.git.push(branch);
        await deps.broker.emit({
          type: 'agent.tool_call',
          taskId,
          payload: { tool: 'git', action: 'push', branch },
        });
        return ok(`pushed ${branch}`);
      }

      case 'status': {
        const status = await deps.git.status();
        return ok(
          [
            `on ${status.branch}`,
            status.clean ? 'nothing to commit' : `${status.changed.length} changed:`,
            ...status.changed,
          ].join('\n'),
        );
      }

      case 'diff': {
        const diff = await deps.git.diff();
        return ok(diff === '' ? 'no changes' : diff);
      }
    }
  } catch (error) {
    return fail((error as Error).message);
  }
}

function ok(content: string): ToolOutcome {
  return { kind: 'result', content, isError: false };
}

function fail(message: string): ToolOutcome {
  return { kind: 'result', content: message, isError: true };
}
