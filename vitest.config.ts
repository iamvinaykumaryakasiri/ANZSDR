import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: 'coverage',
      // The compliance engine decides whether a call may legally happen.
      // Every branch in it is tested; the threshold is enforced, not aspirational.
      include: ['src/compliance/**/*.ts'],
      exclude: ['src/compliance/**/index.ts'],
      thresholds: {
        'src/compliance/**/*.ts': {
          branches: 100,
          functions: 100,
          lines: 100,
          statements: 100
        }
      }
    }
  }
});
