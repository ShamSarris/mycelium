import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The single read path for every long-lived secret on this VM (B13). systemd
 * decrypts `LoadCredentialEncrypted=` blobs into `$CREDENTIALS_DIRECTORY`, so
 * secrets never enter the supervisor's environment and are therefore not
 * inherited by the plan agent it spawns — which is the one boundary where that
 * property matters.
 *
 * The environment fallback exists so the daemon can be run by hand during
 * development. No production unit sets it.
 */
export function loadSecret(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.CREDENTIALS_DIRECTORY;

  if (dir !== undefined && dir !== '') {
    const contents = readFileOrUndefined(path.join(dir, name));
    if (contents !== undefined) {
      const value = contents.trim();
      if (value === '') {
        throw new Error(`credential ${name} is present but empty`);
      }
      return value;
    }
  }

  const fallback = env[name.toUpperCase()];
  if (fallback !== undefined && fallback.trim() !== '') return fallback.trim();

  throw new Error(
    `secret ${name} is not available: no ${name} in $CREDENTIALS_DIRECTORY and no ${name.toUpperCase()} in the environment`,
  );
}

function readFileOrUndefined(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}
