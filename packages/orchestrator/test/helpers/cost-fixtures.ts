/**
 * A schema-valid, cost-denominated plan for the dashboard suites (ticket 06).
 *
 * `helpers/fixtures.ts`'s `validPlan()` is shared with ticket 05's suites and,
 * as of this writing, still carries the pre-migration `limits.tokens` shape —
 * ticket 05 owns bringing it up to date. Rather than edit that shared file
 * from here (two concurrently-running tickets editing the same file is how
 * one of them silently loses work), this module duplicates the same plan
 * shape with cost fields, independent of when or how ticket 05 migrates the
 * shared fixture.
 */
export function costPlan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    goal: 'Add a health endpoint to the orchestrator.',
    project: { name: 'demo' },
    assumptions: ['The orchestrator already has a Fastify instance.'],
    env: 'dev',
    tasks: [
      {
        id: 'a-write-tests',
        description: 'Write failing tests for GET /healthz.',
        limits: { cost_microusd: 50_000, wall_clock_min: 20 },
      },
      {
        id: 'b-implement',
        description: 'Implement GET /healthz until the tests pass.',
        depends_on: ['a-write-tests'],
        limits: { cost_microusd: 100_000, wall_clock_min: 30 },
      },
    ],
    success_criteria: [{ type: 'all_tasks_done' }],
    max_cost_microusd: 500_000,
    ...overrides,
  };
}
