import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // The orchestrator's integration tests share one Postgres database and
    // truncate between tests, so test files must not run concurrently.
    // The contracts tests are fast enough that serialising them costs nothing.
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
