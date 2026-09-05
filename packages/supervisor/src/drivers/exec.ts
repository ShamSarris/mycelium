import { spawn } from 'node:child_process';

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * The drivers shell out rather than take library dependencies on Docker and
 * git. Both are already required on the VM, both have stable CLIs, and a client
 * library would be a third thing to keep in step with what `infra/` installs.
 *
 * Arguments are passed as an array and never through a shell, so a plan name or
 * a branch cannot become a command.
 */
export function exec(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    let timer: NodeJS.Timeout | undefined;

    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs);
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      if (timer !== undefined) clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      if (timer !== undefined) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
