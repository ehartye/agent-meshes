import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Cap parallel workers: the suite times out under worker contention, not because tests are slow.
    maxWorkers: 6,
    // Project default; an explicit per-test or per-file timeout still wins.
    testTimeout: 30000,
  },
});
