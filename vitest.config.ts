import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    ...(process.env.CI ? { maxWorkers: 2 } : {}),
    testTimeout: 15_000,
    hookTimeout: 15_000,
    coverage: { reporter: ['text', 'json-summary'] }
  }
});
