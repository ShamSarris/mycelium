import { describe, expect, it, vi } from 'vitest';
import { allPassed, evaluateCriteria } from '../../src/domain/criteria.js';
import type { TaskState } from '../../src/domain/states.js';

function giteaWith(exists: boolean) {
  return { fileExists: vi.fn(async () => exists) };
}

describe('all_tasks_done', () => {
  it('passes when every task is done', async () => {
    const outcomes = await evaluateCriteria({
      criteria: [{ type: 'all_tasks_done' }],
      taskStates: ['done', 'done'],
      repo: 'demo',
      branch: 'plan/1',
      gitea: giteaWith(true),
    });
    expect(outcomes).toEqual([{ type: 'all_tasks_done', passed: true }]);
  });

  it('fails when a task failed', async () => {
    const outcomes = await evaluateCriteria({
      criteria: [{ type: 'all_tasks_done' }],
      taskStates: ['done', 'failed'],
      repo: 'demo',
      branch: 'plan/1',
      gitea: giteaWith(true),
    });
    expect(outcomes[0]?.passed).toBe(false);
  });

  it('fails when a task was cancelled, because cancelled is not done', async () => {
    const states: TaskState[] = ['done', 'cancelled'];
    const outcomes = await evaluateCriteria({
      criteria: [{ type: 'all_tasks_done' }],
      taskStates: states,
      repo: 'demo',
      branch: 'plan/1',
      gitea: giteaWith(true),
    });
    expect(outcomes[0]?.passed).toBe(false);
  });

  it('fails for a plan with no tasks at all', async () => {
    const outcomes = await evaluateCriteria({
      criteria: [{ type: 'all_tasks_done' }],
      taskStates: [],
      repo: 'demo',
      branch: 'plan/1',
      gitea: giteaWith(true),
    });
    expect(outcomes[0]?.passed).toBe(false);
  });
});

describe('file_exists_in_branch', () => {
  it('delegates to Gitea with the plan branch and reports the path', async () => {
    const gitea = giteaWith(true);
    const outcomes = await evaluateCriteria({
      criteria: [{ type: 'file_exists_in_branch', path: 'docs/report.md' }],
      taskStates: ['done'],
      repo: 'demo',
      branch: 'plan/abc',
      gitea,
    });

    expect(gitea.fileExists).toHaveBeenCalledWith('demo', 'plan/abc', 'docs/report.md');
    expect(outcomes).toEqual([
      { type: 'file_exists_in_branch', path: 'docs/report.md', passed: true },
    ]);
  });

  it('fails when the file is absent', async () => {
    const outcomes = await evaluateCriteria({
      criteria: [{ type: 'file_exists_in_branch', path: 'missing.txt' }],
      taskStates: ['done'],
      repo: 'demo',
      branch: 'plan/abc',
      gitea: giteaWith(false),
    });
    expect(outcomes[0]?.passed).toBe(false);
  });

  it('fails without calling Gitea when the plan never got a repo or branch', async () => {
    const gitea = giteaWith(true);
    const outcomes = await evaluateCriteria({
      criteria: [{ type: 'file_exists_in_branch', path: 'a.txt' }],
      taskStates: ['done'],
      repo: null,
      branch: null,
      gitea,
    });
    expect(gitea.fileExists).not.toHaveBeenCalled();
    expect(outcomes[0]?.passed).toBe(false);
  });
});

describe('combining criteria', () => {
  it('evaluates every criterion and preserves order', async () => {
    const outcomes = await evaluateCriteria({
      criteria: [
        { type: 'all_tasks_done' },
        { type: 'file_exists_in_branch', path: 'out.json' },
      ],
      taskStates: ['done'],
      repo: 'demo',
      branch: 'plan/abc',
      gitea: giteaWith(false),
    });

    expect(outcomes.map((o) => o.type)).toEqual(['all_tasks_done', 'file_exists_in_branch']);
    expect(allPassed(outcomes)).toBe(false);
  });

  it('passes overall only when nothing failed', async () => {
    const outcomes = await evaluateCriteria({
      criteria: [{ type: 'all_tasks_done' }, { type: 'file_exists_in_branch', path: 'out.json' }],
      taskStates: ['done'],
      repo: 'demo',
      branch: 'plan/abc',
      gitea: giteaWith(true),
    });
    expect(allPassed(outcomes)).toBe(true);
  });
});
