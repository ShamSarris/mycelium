/** The smallest plan that satisfies baseline section 6. Tests clone and mutate it. */
export function validPlan(): Record<string, any> {
  return {
    goal: 'Add a health endpoint to the orchestrator.',
    project: { name: 'mycelium' },
    assumptions: ['The orchestrator already has a Fastify instance.'],
    env: 'dev',
    tasks: [
      {
        id: 'write-tests',
        description: 'Write failing tests for GET /healthz.',
        limits: { tokens: 50000, wall_clock_min: 20 },
      },
      {
        id: 'implement',
        description: 'Implement GET /healthz until the tests pass.',
        depends_on: ['write-tests'],
        limits: { tokens: 100000, wall_clock_min: 30 },
        failure_policy: { type: 'retry', max_attempts: 2 },
      },
    ],
    success_criteria: [{ type: 'all_tasks_done' }],
  };
}

/** A valid event envelope. Tests clone and mutate it. */
export function validEvent(): Record<string, any> {
  return {
    event_id: '018f3a5c-0000-7000-8000-000000000001',
    ts: '2026-09-02T12:00:00.000Z',
    source: 'agent',
    stream_id: 'plan-agent-018f3a5c',
    seq: 0,
    type: 'agent.tool_call',
  };
}
