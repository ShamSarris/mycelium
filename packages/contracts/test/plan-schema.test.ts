import { describe, expect, it } from 'vitest';
import { validatePlan } from '../src/index.js';
import { validPlan } from './fixtures/valid-plan.js';

/** Assert the plan is rejected and return the issue codes. */
function codes(input: unknown): string[] {
  const result = validatePlan(input);
  expect(result.ok, 'expected the plan to be rejected').toBe(false);
  return result.ok ? [] : result.issues.map((i) => i.code);
}

describe('validatePlan - acceptance', () => {
  it('accepts the minimal valid plan', () => {
    expect(validatePlan(validPlan()).ok).toBe(true);
  });

  it('accepts an existing project referenced by id', () => {
    const plan = validPlan();
    plan.project = { id: '018f3a5c-0000-7000-8000-000000000000' };
    expect(validatePlan(plan).ok).toBe(true);
  });

  it('does not mutate the input document', () => {
    const plan = validPlan();
    const before = JSON.stringify(plan);
    validatePlan(plan);
    expect(JSON.stringify(plan)).toBe(before);
  });
});

describe('validatePlan - defaults', () => {
  it('applies documented defaults to the returned plan', () => {
    const result = validatePlan(validPlan());
    if (!result.ok) throw new Error('expected valid');
    const plan = result.value;

    expect(plan.max_concurrent_agents).toBe(2);
    expect(plan.env_ttl_min).toBe(240);
    expect(plan.non_goals).toEqual([]);
    expect(plan.tasks[0]!.depends_on).toEqual([]);
    expect(plan.tasks[0]!.failure_policy).toEqual({ type: 'halt' });
  });
});

describe('validatePlan - approval gate requirements (G2)', () => {
  it('rejects a plan with no assumptions', () => {
    const plan = validPlan();
    plan.assumptions = [];
    expect(codes(plan)).toContain('minItems');
  });

  it('rejects a missing assumptions field', () => {
    const plan = validPlan();
    delete plan.assumptions;
    expect(codes(plan)).toContain('required');
  });

  it('rejects an empty assumption string', () => {
    const plan = validPlan();
    plan.assumptions = [''];
    expect(codes(plan)).toContain('minLength');
  });
});

describe('validatePlan - per-task limits', () => {
  it('rejects tokens above 500k', () => {
    const plan = validPlan();
    plan.tasks[0].limits.tokens = 500_001;
    expect(codes(plan)).toContain('maximum');
  });

  it('accepts tokens exactly at 500k', () => {
    const plan = validPlan();
    plan.tasks[0].limits.tokens = 500_000;
    expect(validatePlan(plan).ok).toBe(true);
  });

  it('rejects wall_clock_min above 120', () => {
    const plan = validPlan();
    plan.tasks[0].limits.wall_clock_min = 121;
    expect(codes(plan)).toContain('maximum');
  });

  it('rejects a task with no limits', () => {
    const plan = validPlan();
    delete plan.tasks[0].limits;
    expect(codes(plan)).toContain('required');
  });
});

describe('validatePlan - concurrency', () => {
  it('rejects max_concurrent_agents above 4', () => {
    const plan = validPlan();
    plan.max_concurrent_agents = 5;
    expect(codes(plan)).toContain('maximum');
  });

  it('rejects max_concurrent_agents below 1', () => {
    const plan = validPlan();
    plan.max_concurrent_agents = 0;
    expect(codes(plan)).toContain('minimum');
  });
});

describe('validatePlan - task DAG', () => {
  it('rejects a dependency on an unknown task', () => {
    const plan = validPlan();
    plan.tasks[1].depends_on = ['does-not-exist'];
    expect(codes(plan)).toContain('unknown_dependency');
  });

  it('rejects a task that depends on itself', () => {
    const plan = validPlan();
    plan.tasks[1].depends_on = ['implement'];
    expect(codes(plan)).toContain('self_dependency');
  });

  it('rejects a two-node cycle', () => {
    const plan = validPlan();
    plan.tasks[0].depends_on = ['implement'];
    plan.tasks[1].depends_on = ['write-tests'];
    expect(codes(plan)).toContain('dependency_cycle');
  });

  it('rejects a three-node cycle', () => {
    const plan = validPlan();
    const limits = { tokens: 1000, wall_clock_min: 5 };
    plan.tasks = [
      { id: 'a', description: 'a', depends_on: ['c'], limits },
      { id: 'b', description: 'b', depends_on: ['a'], limits },
      { id: 'c', description: 'c', depends_on: ['b'], limits },
    ];
    expect(codes(plan)).toContain('dependency_cycle');
  });

  it('accepts a diamond, which is acyclic', () => {
    const plan = validPlan();
    const limits = { tokens: 1000, wall_clock_min: 5 };
    plan.tasks = [
      { id: 'a', description: 'a', limits },
      { id: 'b', description: 'b', depends_on: ['a'], limits },
      { id: 'c', description: 'c', depends_on: ['a'], limits },
      { id: 'd', description: 'd', depends_on: ['b', 'c'], limits },
    ];
    expect(validatePlan(plan).ok).toBe(true);
  });

  it('rejects duplicate task ids', () => {
    const plan = validPlan();
    plan.tasks[1].id = 'write-tests';
    expect(codes(plan)).toContain('duplicate_task_id');
  });

  it('rejects a plan with no tasks', () => {
    const plan = validPlan();
    plan.tasks = [];
    expect(codes(plan)).toContain('minItems');
  });
});

describe('validatePlan - success criteria', () => {
  it('accepts file_exists_in_branch with a repo-relative path', () => {
    const plan = validPlan();
    plan.success_criteria = [{ type: 'file_exists_in_branch', path: 'src/health.ts' }];
    expect(validatePlan(plan).ok).toBe(true);
  });

  it('rejects a criterion type outside the v1 set', () => {
    const plan = validPlan();
    plan.success_criteria = [{ type: 'row_count_min', min: 10 }];
    expect(validatePlan(plan).ok).toBe(false);
  });

  it('rejects file_exists_in_branch without a path', () => {
    const plan = validPlan();
    plan.success_criteria = [{ type: 'file_exists_in_branch' }];
    expect(validatePlan(plan).ok).toBe(false);
  });

  it('rejects an absolute path', () => {
    const plan = validPlan();
    plan.success_criteria = [{ type: 'file_exists_in_branch', path: '/etc/passwd' }];
    expect(validatePlan(plan).ok).toBe(false);
  });

  it('rejects a path that escapes the repo', () => {
    const plan = validPlan();
    plan.success_criteria = [{ type: 'file_exists_in_branch', path: '../../etc/passwd' }];
    expect(validatePlan(plan).ok).toBe(false);
  });

  it('rejects an empty success_criteria list', () => {
    const plan = validPlan();
    plan.success_criteria = [];
    expect(codes(plan)).toContain('minItems');
  });
});

describe('validatePlan - shape', () => {
  it('rejects an unknown top-level field', () => {
    const plan = validPlan();
    plan.budget_usd = 25;
    expect(codes(plan)).toContain('additionalProperties');
  });

  it('rejects an env outside dev|prod', () => {
    const plan = validPlan();
    plan.env = 'staging';
    expect(validatePlan(plan).ok).toBe(false);
  });

  it('rejects a non-slug project name', () => {
    const plan = validPlan();
    plan.project = { name: 'My Project' };
    expect(validatePlan(plan).ok).toBe(false);
  });

  it('rejects a project carrying both id and name', () => {
    const plan = validPlan();
    plan.project = { id: '018f3a5c-0000-7000-8000-000000000000', name: 'mycelium' };
    expect(validatePlan(plan).ok).toBe(false);
  });

  it('rejects retry without max_attempts', () => {
    const plan = validPlan();
    plan.tasks[1].failure_policy = { type: 'retry' };
    expect(validatePlan(plan).ok).toBe(false);
  });

  it('rejects a non-object plan', () => {
    expect(validatePlan(null).ok).toBe(false);
    expect(validatePlan('plan').ok).toBe(false);
  });

  it('reports a JSON Pointer path on each issue', () => {
    const plan = validPlan();
    plan.tasks[0].limits.tokens = 500_001;
    const result = validatePlan(plan);
    if (result.ok) throw new Error('expected failure');
    expect(result.issues.some((i) => i.path === '/tasks/0/limits/tokens')).toBe(true);
  });
});
