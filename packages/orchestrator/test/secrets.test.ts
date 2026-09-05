import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSecret } from '../src/secrets.js';
import { loadConfig } from '../src/config.js';

/**
 * B13: the long-lived secrets are delivered as systemd encrypted credentials
 * and read from `$CREDENTIALS_DIRECTORY`, so they never enter the service's
 * environment. `config.ts` has said since ticket 0002 that this helper "lands
 * with infra/ and replaces the reads here without touching any call site" —
 * this is that.
 *
 * Deliberately the same shape as the supervisor's, including the development
 * fallback, so there is one pattern to understand rather than two.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'mycelium-creds-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function credential(name: string, value: string): Promise<void> {
  await writeFile(path.join(dir, name), value);
}

describe('loadSecret', () => {
  it('reads a credential systemd placed in the directory', async () => {
    await credential('gitea_admin_token', 'from-the-credential-store\n');

    expect(loadSecret('gitea_admin_token', { CREDENTIALS_DIRECTORY: dir })).toBe(
      'from-the-credential-store',
    );
  });

  it('prefers the credential over an environment variable of the same name', async () => {
    await credential('gitea_admin_token', 'from-the-credential-store');

    // If both exist the credential wins, so a stale environment variable on a
    // VM cannot quietly outrank what systemd decrypted.
    expect(
      loadSecret('gitea_admin_token', {
        CREDENTIALS_DIRECTORY: dir,
        GITEA_ADMIN_TOKEN: 'from-the-environment',
      }),
    ).toBe('from-the-credential-store');
  });

  it('falls back to the uppercased environment variable for development', () => {
    // No unit sets these. `docker compose up` and a shell do.
    expect(loadSecret('gitea_admin_token', { GITEA_ADMIN_TOKEN: 'dev-token' })).toBe('dev-token');
  });

  it('returns empty rather than throwing when a secret is absent', () => {
    // An absent Gitea token is a legitimate development configuration; the
    // call sites already treat empty as unconfigured.
    expect(loadSecret('gitea_admin_token', {})).toBe('');
  });

  it('trims, because a credential file usually ends in a newline', async () => {
    await credential('postgres_password', '  hunter2  \n');

    expect(loadSecret('postgres_password', { CREDENTIALS_DIRECTORY: dir })).toBe('hunter2');
  });
});

describe('loadConfig with credentials', () => {
  const base = { DATABASE_URL: 'postgres://mycelium@127.0.0.1:5432/mycelium' };

  it('takes the Gitea admin token from the credential store', async () => {
    await credential('gitea_admin_token', 'ghp-real');

    const config = loadConfig({ ...base, CREDENTIALS_DIRECTORY: dir });

    expect(config.gitea.adminToken).toBe('ghp-real');
  });

  it('fills the database password from its credential, so the URL carries none', async () => {
    await credential('postgres_password', 'hunter2');

    const config = loadConfig({ ...base, CREDENTIALS_DIRECTORY: dir });

    // The unit file and the process environment hold a password-free URL; the
    // password only ever exists in the decrypted credential and in memory.
    expect(config.databaseUrl).toBe('postgres://mycelium:hunter2@127.0.0.1:5432/mycelium');
  });

  it('leaves a URL that already carries a password alone', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://mycelium:inline@127.0.0.1:5432/mycelium',
    });

    // Development and the test harness both pass one inline, and quietly
    // rewriting it would be a surprising thing for a config loader to do.
    expect(config.databaseUrl).toBe('postgres://mycelium:inline@127.0.0.1:5432/mycelium');
  });

  it('leaves the URL alone when there is no password credential', () => {
    const config = loadConfig(base);

    expect(config.databaseUrl).toBe('postgres://mycelium@127.0.0.1:5432/mycelium');
  });

  it('still defaults the host to loopback', () => {
    // Serve is the only ingress, for supervisors as well as the operator
    // (ticket 0007 §4.1). Nothing binds a public interface.
    expect(loadConfig(base).host).toBe('127.0.0.1');
  });
});
