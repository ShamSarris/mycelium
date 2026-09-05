import type { ValidationIssue } from './errors.js';

interface TaskLike {
  id: string;
  depends_on?: string[];
}

/**
 * Checks the task DAG invariants that JSON Schema cannot express: unique ids,
 * resolvable dependencies, no self-edges, and acyclicity. Assumes the document
 * has already passed schema validation, so shapes are trusted here.
 */
export function checkTaskGraph(tasks: readonly TaskLike[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();

  tasks.forEach((task, i) => {
    if (seen.has(task.id)) {
      issues.push({
        kind: 'semantic',
        code: 'duplicate_task_id',
        path: `/tasks/${i}/id`,
        message: `Duplicate task id "${task.id}".`,
      });
    }
    seen.add(task.id);
  });

  tasks.forEach((task, i) => {
    (task.depends_on ?? []).forEach((dep, j) => {
      const path = `/tasks/${i}/depends_on/${j}`;
      if (dep === task.id) {
        issues.push({
          kind: 'semantic',
          code: 'self_dependency',
          path,
          message: `Task "${task.id}" depends on itself.`,
        });
      } else if (!seen.has(dep)) {
        issues.push({
          kind: 'semantic',
          code: 'unknown_dependency',
          path,
          message: `Task "${task.id}" depends on unknown task "${dep}".`,
        });
      }
    });
  });

  const cycle = findCycle(tasks);
  if (cycle) {
    issues.push({
      kind: 'semantic',
      code: 'dependency_cycle',
      path: '/tasks',
      message: `Dependency cycle: ${cycle.join(' -> ')}.`,
    });
  }

  return issues;
}

/** Returns one cycle as a closed id path, or null. Iterative DFS with a colour map. */
function findCycle(tasks: readonly TaskLike[]): string[] | null {
  const deps = new Map<string, string[]>();
  for (const task of tasks) {
    // A duplicate id keeps the first definition; duplicates are reported separately.
    if (!deps.has(task.id)) deps.set(task.id, [...(task.depends_on ?? [])]);
  }

  const WHITE = 0, GREY = 1, BLACK = 2;
  const colour = new Map<string, number>();
  for (const id of deps.keys()) colour.set(id, WHITE);

  for (const root of deps.keys()) {
    if (colour.get(root) !== WHITE) continue;

    const stack: Array<{ id: string; next: number }> = [{ id: root, next: 0 }];
    colour.set(root, GREY);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const edges = deps.get(frame.id) ?? [];

      if (frame.next >= edges.length) {
        colour.set(frame.id, BLACK);
        stack.pop();
        continue;
      }

      const next = edges[frame.next++]!;
      if (!deps.has(next)) continue; // unknown dep, already reported

      if (colour.get(next) === GREY) {
        const from = stack.findIndex((f) => f.id === next);
        return [...stack.slice(from).map((f) => f.id), next];
      }
      if (colour.get(next) === WHITE) {
        colour.set(next, GREY);
        stack.push({ id: next, next: 0 });
      }
    }
  }

  return null;
}
