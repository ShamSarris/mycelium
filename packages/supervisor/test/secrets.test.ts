import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSecret } from '../src/secrets.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'mycelium-creds-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// B13: systemd delivers secrets as encrypted credentials, and every read goes
// through this one helper. The env fallback exists so the daemon can be run by
// hand during development; production units set CREDENTIALS_DIRECTORY.
describe('loadSecret', () => {
  it('reads a credential from the systemd credentials directory', async () => {
    await writeFile(path.join(dir, 'supervisor_token'), 'tok-from-systemd');
    expect(loadSecret('supervisor_token', { CREDENTIALS_DIRECTORY: dir })).toBe('tok-from-systemd');
  });

  it('strips the trailing newline a credential file usually carries', async () => {
    await writeFile(path.join(dir, 'supervisor_token'), 'tok-from-systemd\n');
    expect(loadSecret('supervisor_token', { CREDENTIALS_DIRECTORY: dir })).toBe('tok-from-systemd');
  });

  it('prefers the credential file over the environment fallback', async () => {
    await writeFile(path.join(dir, 'supervisor_token'), 'tok-from-systemd');
    const value = loadSecret('supervisor_token', {
      CREDENTIALS_DIRECTORY: dir,
      SUPERVISOR_TOKEN: 'tok-from-env',
    });
    expect(value).toBe('tok-from-systemd');
  });

  it('falls back to the upper-cased environment variable for development', () => {
    expect(loadSecret('supervisor_token', { SUPERVISOR_TOKEN: 'tok-from-env' })).toBe(
      'tok-from-env',
    );
  });

  it('falls back when the credentials directory exists but lacks that name', () => {
    const value = loadSecret('model_api_key', {
      CREDENTIALS_DIRECTORY: dir,
      MODEL_API_KEY: 'sk-dev',
    });
    expect(value).toBe('sk-dev');
  });

  it('throws naming the secret when neither source has it', () => {
    expect(() => loadSecret('model_api_key', {})).toThrow(/model_api_key/);
  });

  it('throws rather than returning an empty credential', async () => {
    await writeFile(path.join(dir, 'model_api_key'), '   \n');
    expect(() => loadSecret('model_api_key', { CREDENTIALS_DIRECTORY: dir })).toThrow(
      /model_api_key/,
    );
  });
});
