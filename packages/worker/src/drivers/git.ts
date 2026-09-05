import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BranchNotAllowed, type GitClient, type GitStatus } from '../tools/git.js';

const run = promisify(execFile);

/** The name the helper reads. Nothing else this process runs sees it. */
const TOKEN_VAR = 'MYCELIUM_GIT_TOKEN';

/**
 * A credential helper that answers from the environment. Git runs it through a
 * shell, so the token is referenced rather than written: it appears in no
 * argument, and `-c` before the subcommand applies to this invocation only, so
 * git persists nothing.
 */
const CREDENTIAL_HELPER = `credential.helper=!f() { echo username=x-access-token; echo "password=$${TOKEN_VAR}"; }; f`;

/**
 * Git over the CLI, in the plan checkout.
 *
 * The token is supplied per push and lives nowhere else. It used to sit in
 * `.git/config`, left there by the clone — which put it inside the file tools'
 * root and inside the tree bind-mounted into the sandbox, so a
 * prompt-injectable model and a credential-free container could both read it
 * (ticket 0005 part A). The supervisor no longer writes it, and this no longer
 * needs it to be there.
 *
 * What this also owns is the identity on the commits and the refusal to push
 * anywhere but the plan branch.
 */
export class CliGitClient implements GitClient {
  constructor(
    private readonly workdir: string,
    private readonly branch: string,
    /** The per-plan bot token. Held in memory, passed to git through its environment. */
    private readonly token: string,
    private readonly author = { name: 'mycelium plan agent', email: 'plan-agent@mycelium.local' },
    private readonly timeoutMs = 120_000,
  ) {}

  async commit(message: string): Promise<string | null> {
    await this.git(['add', '-A']);

    if ((await this.status()).clean) return null;

    // The identity is set per-invocation rather than written into the clone's
    // config: the environment is ephemeral, and a commit with no author is a
    // commit git refuses to make.
    await this.git([
      '-c',
      `user.name=${this.author.name}`,
      '-c',
      `user.email=${this.author.email}`,
      'commit',
      '-m',
      message,
    ]);

    return this.head();
  }

  async push(branch: string): Promise<void> {
    // Belt and braces with the tool-level check and with Gitea's protected
    // branches (D19). This is the last place that can refuse before a
    // credential is used.
    if (branch !== this.branch) throw new BranchNotAllowed(branch, this.branch);
    await this.git(['-c', CREDENTIAL_HELPER, 'push', 'origin', `HEAD:refs/heads/${branch}`], {
      [TOKEN_VAR]: this.token,
    });
  }

  async status(): Promise<GitStatus> {
    const porcelain = await this.git(['status', '--porcelain']);
    const changed = porcelain
      .split('\n')
      .map((line) => line.slice(3).trim())
      .filter((line) => line !== '');

    return {
      branch: (await this.git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim(),
      clean: changed.length === 0,
      changed,
    };
  }

  async diff(): Promise<string> {
    // Staged as well as unstaged: `commit` stages everything, so a diff that
    // showed only the working tree would go blank at exactly the wrong moment.
    return this.git(['diff', 'HEAD']);
  }

  async head(): Promise<string> {
    return (await this.git(['rev-parse', 'HEAD'])).trim();
  }

  private async git(args: string[], extraEnv: Record<string, string> = {}): Promise<string> {
    try {
      const { stdout } = await run('git', args, {
        cwd: this.workdir,
        timeout: this.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv },
      });
      return stdout;
    } catch (error) {
      // git says useful things on stderr and nothing on stdout when it fails,
      // and the model is the one who has to act on it. The token is stripped
      // first: git echoes a remote URL in most of its failures, and this
      // message goes straight into a model context.
      const stderr = (error as { stderr?: string }).stderr;
      const message = (stderr ?? (error as Error).message).split(this.token).join('[redacted]');
      throw new Error(
        `git ${subcommand(args)} failed: ${message.trim().split('\n').slice(0, 5).join('; ')}`,
      );
    }
  }
}

/** The first argument that is not a `-c key=value` pair, for the error message. */
function subcommand(args: string[]): string {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '-c') {
      i += 1;
      continue;
    }
    return args[i] ?? 'command';
  }
  return 'command';
}
