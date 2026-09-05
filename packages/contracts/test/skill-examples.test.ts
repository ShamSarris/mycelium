import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validatePlan } from '../src/validate.js';

/**
 * The regression test that keeps the plan skill honest about a schema it never
 * copies.
 *
 * The skill validates by submitting, so nothing in `skills/` holds a schema and
 * nothing can drift from one at runtime. What *can* drift is the teaching
 * material: an example that stops validating, or a template whose blanks stop
 * matching what the schema requires. Both would mislead every plan written
 * afterwards, and neither would fail anywhere else.
 *
 * It lives here because this package owns the validator.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const skill = path.resolve(here, '..', '..', '..', 'skills', 'plan');

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8'));
}

/** Read the directory rather than listing names, so a later example is covered by construction. */
const exampleFiles = (await readdir(path.join(skill, 'examples')))
  .filter((name) => name.endsWith('.json'))
  .sort();

describe('the skill ships examples that actually validate', () => {
  it('has examples at all', () => {
    expect(exampleFiles.length).toBeGreaterThan(0);
  });

  it.each(exampleFiles)('%s validates against plan.schema.json', async (name) => {
    const result = validatePlan(await readJson(path.join(skill, 'examples', name)));

    // The message matters: a bare `false` here would send someone hunting.
    expect(result.ok ? [] : result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it.each(exampleFiles)('%s uses only success criteria the orchestrator can check', async (name) => {
    const plan = (await readJson(path.join(skill, 'examples', name))) as {
      success_criteria: Array<{ type: string }>;
    };

    // The schema enforces this too. Asserting it here is about the teaching:
    // an example criterion the orchestrator cannot evaluate would teach the
    // wrong shape even if it happened to parse.
    for (const criterion of plan.success_criteria) {
      expect(['all_tasks_done', 'file_exists_in_branch']).toContain(criterion.type);
    }
  });

  it.each(exampleFiles)('%s only depends on tasks that exist', async (name) => {
    const plan = (await readJson(path.join(skill, 'examples', name))) as {
      tasks: Array<{ id: string; depends_on?: string[] }>;
    };
    const ids = new Set(plan.tasks.map((task) => task.id));

    for (const task of plan.tasks) {
      for (const dependency of task.depends_on ?? []) {
        expect(ids, `${task.id} depends on ${dependency}`).toContain(dependency);
      }
    }
  });

  it.each(exampleFiles)('%s declares non-goals, which the skill treats as required', async (name) => {
    const plan = (await readJson(path.join(skill, 'examples', name))) as { non_goals?: string[] };

    // The schema allows them to be absent; the skill does not, because they
    // are the only thing bounding a prompt-injectable agent's scope.
    expect(plan.non_goals?.length ?? 0).toBeGreaterThan(0);
  });
});

describe('the template is a skeleton, not a plan', () => {
  it('does not validate, because a template with no blanks left has stopped being one', async () => {
    const result = validatePlan(await readJson(path.join(skill, 'template.json')));

    expect(result.ok).toBe(false);
  });

  it('fails only on the fields it deliberately leaves blank', async () => {
    const result = validatePlan(await readJson(path.join(skill, 'template.json')));
    if (result.ok) throw new Error('the template validated, so it has no blanks left');

    // Pinned, so that a schema change which alters what a skeleton must
    // contain fails here rather than silently making the template wrong.
    const paths = [...new Set(result.issues.map((issue) => issue.path))].sort();
    expect(paths).toEqual(['/']);

    const missing = result.issues
      .filter((issue) => issue.code === 'required')
      .map((issue) => issue.message)
      .join(' ');
    expect(missing).toContain('goal');
    expect(missing).toContain('project');
    expect(missing).toContain('assumptions');
  });
});
