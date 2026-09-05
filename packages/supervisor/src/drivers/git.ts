import { exec } from './exec.js';

/**
 * Cloning the project repo at the plan's branch. Behind an interface for the
 * same reason as the container driver: the logic worth testing is what the
 * supervisor does with each failure, not what git prints.
 */

export interface CloneSpec {
  repoUrl: string;
  branch: string;
  /** The per-plan repo-scoped bot token, minted at approval. */
  token: string;
  dir: string;
}

/**
 * `missing_branch` and `missing_repo` are the plan's fault and terminal: the
 * orchestrator created `plan/<id>` at approval, so its absence is a bug rather
 * than a race, and trying the next VM would fail identically. Everything else
 * is this VM's problem and the orchestrator should look elsewhere.
 */
export type CloneFailure = 'missing_branch' | 'missing_repo' | 'transient';

export class CloneError extends Error {
  constructor(
    readonly reason: CloneFailure,
    message: string,
  ) {
    super(message);
    this.name = 'CloneError';
  }
}

export interface GitClient {
  clone(spec: CloneSpec): Promise<void>;
}

/** The name the helper reads. Nothing else in the environment carries a secret. */
const TOKEN_VAR = 'MYCELIUM_GIT_TOKEN';

/**
 * A credential helper that answers from the environment. Git runs it through a
 * shell, so the token is referenced rather than written: it appears in no
 * argument, and — because `-c` before the subcommand applies to that
 * invocation only — in nothing git persists into the new repository's config.
 */
const CREDENTIAL_HELPER = `credential.helper=!f() { echo username=x-access-token; echo "password=$${TOKEN_VAR}"; }; f`;

/**
 * Clones the plan branch without leaving the bot token anywhere in the tree.
 *
 * It used to clone from a URL with the token embedded, which put the token in
 * `.git/config` for the life of the environment. `.git` sits inside the
 * checkout, the checkout is the plan agent's file-tool root, and the same tree
 * is bind-mounted into the sandbox — so that token was readable both by a
 * prompt-injectable model and by a container that is supposed to hold no
 * credentials at all. Ticket 0005 part A; it retires ticket 0003 gap 6.
 *
 * The token never reaches a log line either: git's own output is only surfaced
 * after the token has been stripped out of it, which costs nothing and covers
 * whatever git decides to echo next.
 */
export class CliGitClient implements GitClient {
  constructor(
    private readonly timeoutMs = 120_000,
    /** Injected so a test can read the arguments and environment git is handed. */
    private readonly run: typeof exec = exec,
  ) {}

  async clone(spec: CloneSpec): Promise<void> {
    const result = await this.run(
      'git',
      [
        '-c',
        CREDENTIAL_HELPER,
        'clone',
        '--branch',
        spec.branch,
        // The agent commits and pushes on this branch and reads no history it
        // did not write, so the rest of the repo is bandwidth for nothing.
        '--depth',
        '1',
        '--single-branch',
        spec.repoUrl,
        spec.dir,
      ],
      {
        timeoutMs: this.timeoutMs,
        // Deliberately not the supervisor's own environment. B13 says there is
        // nothing in it for a child to inherit; constructing this one keeps
        // that true rather than trusting it.
        env: {
          PATH: process.env.PATH ?? '',
          ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
          HOME: process.env.HOME ?? process.env.USERPROFILE ?? '',
          // No system or global config, so nothing on the VM can add a remote,
          // a helper, or an insteadOf rule to a plan's clone.
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_TERMINAL_PROMPT: '0',
          [TOKEN_VAR]: spec.token,
        },
      },
    );

    if (result.code === 0) return;

    const message = redact(result.stderr, spec.token);

    // The orchestrator created plan/<id> at approval, so a missing ref is a
    // bug rather than a race, and it is terminal: no other VM would fare
    // better. Everything else is this VM's problem.
    if (/Remote branch .* not found|couldn't find remote ref/i.test(message)) {
      throw new CloneError('missing_branch', `branch ${spec.branch} is not in the repository`);
    }
    if (/repository .* not found|does not appear to be a git repository|404/i.test(message)) {
      throw new CloneError('missing_repo', 'the repository does not exist');
    }

    throw new CloneError('transient', message.trim().slice(0, 500));
  }
}

/** Belt and braces: git echoes the remote URL in most of its failures. */
function redact(text: string, token: string): string {
  return text.split(token).join('[redacted]');
}
