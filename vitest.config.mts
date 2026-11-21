import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Temporal's native core-bridge is happiest in a forked process.
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 120_000,
    env: { LOG_LEVEL: 'silent', NODE_ENV: 'test' },
  },
});
