import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The single read path for every long-lived secret on this VM (B13). systemd
 * decrypts `LoadCredentialEncrypted=` blobs into `$CREDENTIALS_DIRECTORY`, so
 * secrets never enter the service's environment — which is what keeps them out
 * of `/proc/<pid>/environ`, out of a `systemctl show`, and out of anything a
 * child process would inherit.
 *
 * Deliberately the same shape as the supervisor's, down to the development
 * fallback, so there is one pattern here rather than two. The difference is
 * that an absent secret is empty rather than fatal: an unconfigured Gitea token
 * is a legitimate development state and the call sites already treat it as one.
 */
export function loadSecret(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.CREDENTIALS_DIRECTORY;

  if (dir !== undefined && dir !== '') {
    const contents = readFileOrUndefined(path.join(dir, name));
    // The credential wins over the environment when both exist, so a stale
    // variable left on a VM cannot outrank what systemd decrypted.
    if (contents !== undefined) return contents.trim();
  }

  return (env[name.toUpperCase()] ?? '').trim();
}

function readFileOrUndefined(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}
