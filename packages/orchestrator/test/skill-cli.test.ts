import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, OPERATOR, type TestHarness } from './helpers/app.js';
import { propose, validPlan } from './helpers/fixtures.js';

/**
 * The plan skill's one piece of code, tested against the orchestrator's own
 * test app over a real socket — so the calls it makes are the calls the routes
 * answer, including the loopback rule and the identity header the operator
 * surface requires.
 *
 * It lives in this package because this is where the app it talks to is built.
 * The script itself is in `skills/plan/`, where the skill that uses it is.
 */

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, '..', '..', '..', 'skills', 'plan', 'mycelium.mjs');

let h: TestHarness;
let baseUrl: string;
let scratch: string;

beforeAll(async () => {
  h = await buildTestApp();
  // A real listener on loopback: `requireOperator` refuses anything else, and
  // inject() would bypass exactly the rule worth exercising.
  await h.app.listen({ port: 0, host: '127.0.0.1' });
  const address = h.app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await h.reset();
  scratch = await mkdtemp(path.join(tmpdir(), 'mycelium-cli-'));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

async function cliRun(args: string[], env: Record<string, string> = {}): Promise<Result> {
  try {
    const { stdout, stderr } = await run('node', [cli, ...args], {
      env: {
        ...process.env,
        MYCELIUM_URL: baseUrl,
        MYCELIUM_OPERATOR: OPERATOR,
        ...env,
      },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

async function planFile(plan: Record<string, unknown>): Promise<string> {
  const file = path.join(scratch, 'plan.json');
  await writeFile(file, JSON.stringify(plan, null, 2));
  return file;
}

describe('propose', () => {
  it('submits a valid plan and prints its id', async () => {
    const result = await cliRun(['propose', await planFile(validPlan())]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/[0-9a-f-]{36}/);

    const { rows } = await h.pool.query('SELECT id FROM plans');
    expect(rows).toHaveLength(1);
  });

  it('prints each validation issue by path and message, not a bare 400', async () => {
    const result = await cliRun([
      'propose',
      await planFile({ ...validPlan(), assumptions: [] }),
    ]);

    expect(result.code).not.toBe(0);
    // The whole point of validating by submitting is that these come back
    // precise; swallowing them into "400 Bad Request" would waste that.
    const output = result.stdout + result.stderr;
    expect(output).toContain('assumptions');
    expect(output).not.toMatch(/^400$/m);
  });

  it('says which file it could not read rather than failing obscurely', async () => {
    const result = await cliRun(['propose', path.join(scratch, 'nope.json')]);

    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('nope.json');
  });

  it('says the file is not JSON when it is not', async () => {
    const file = path.join(scratch, 'bad.json');
    await writeFile(file, '{ not json');

    const result = await cliRun(['propose', file]);

    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/JSON/i);
  });
});

describe('show', () => {
  it('prints what the operator is being asked to approve', async () => {
    const { plan_id } = await propose(h, {
      ...validPlan(),
      non_goals: ['Do not touch the deploy pipeline.'],
      max_tokens: 90_000,
      egress: ['pypi.org'],
    });

    const result = await cliRun(['show', plan_id]);

    expect(result.code, result.stderr).toBe(0);
    // Everything the gate covers, not just the assumptions.
    expect(result.stdout).toContain('Do not touch the deploy pipeline.');
    expect(result.stdout).toContain('90000');
    expect(result.stdout).toContain('pypi.org');
    expect(result.stdout).toContain((validPlan().assumptions as string[])[0] as string);
  });

  it('lists the tasks so the shape of the DAG is visible', async () => {
    const { plan_id } = await propose(h, validPlan());

    const result = await cliRun(['show', plan_id]);

    for (const task of validPlan().tasks as Array<{ id: string }>) {
      expect(result.stdout).toContain(task.id);
    }
  });
});

describe('approve and reject', () => {
  it('approves a proposed plan', async () => {
    const { plan_id } = await propose(h, validPlan());

    const result = await cliRun(['approve', plan_id]);

    expect(result.code, result.stderr).toBe(0);
    const { rows } = await h.pool.query<{ state: string }>(
      'SELECT state::text AS state FROM plans WHERE id = $1',
      [plan_id],
    );
    expect(rows[0]?.state).toBe('queued');
  });

  it('rejects a proposed plan', async () => {
    const { plan_id } = await propose(h, validPlan());

    const result = await cliRun(['reject', plan_id]);

    expect(result.code, result.stderr).toBe(0);
    const { rows } = await h.pool.query<{ state: string }>(
      'SELECT state::text AS state FROM plans WHERE id = $1',
      [plan_id],
    );
    expect(rows[0]?.state).toBe('rejected');
  });

  it('reports the orchestrator is refusal rather than claiming success', async () => {
    const { plan_id } = await propose(h, validPlan());
    await cliRun(['reject', plan_id]);

    const result = await cliRun(['approve', plan_id]);

    expect(result.code).not.toBe(0);
    expect((result.stdout + result.stderr).toLowerCase()).toContain('reject');
  });
});

describe('status and events', () => {
  it('shows per-task state and spend', async () => {
    const { plan_id } = await propose(h, validPlan());

    const result = await cliRun(['status', plan_id]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('proposed');
    expect(result.stdout).toContain('pending');
  });

  it('reads the event log for a plan', async () => {
    const { plan_id } = await propose(h, validPlan());

    const result = await cliRun(['events', plan_id]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('plan.state_changed');
  });
});

describe('when things are wrong', () => {
  it('names the URL it tried when the orchestrator is unreachable', async () => {
    // The first error anyone hits, and the one where a stack trace helps least.
    const result = await cliRun(['show', 'whatever'], { MYCELIUM_URL: 'http://127.0.0.1:1' });

    expect(result.code).not.toBe(0);
    const output = result.stdout + result.stderr;
    expect(output).toContain('http://127.0.0.1:1');
    expect(output.toLowerCase()).toContain('unreachable');
  });

  it('reports an identity the allowlist does not carry', async () => {
    const result = await cliRun(['show', 'whatever'], { MYCELIUM_OPERATOR: 'nobody@example.com' });

    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('nobody@example.com');
  });

  it('refuses an unknown command instead of guessing', async () => {
    const result = await cliRun(['destroy', 'everything']);

    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('destroy');
  });

  it('prints usage with no arguments at all', async () => {
    const result = await cliRun([]);

    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('propose');
  });
});
