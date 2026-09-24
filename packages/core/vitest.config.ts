import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/tax/**', 'src/numbering/**', 'src/integrity/**', 'src/clock/**'],
      // Modules à risque fiscal : un bug ici se traduit par un redressement client.
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 80,
      },
    },
  },
});
