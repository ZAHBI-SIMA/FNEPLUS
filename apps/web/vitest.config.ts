import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // `node:sqlite` est encore marqué expérimental : l'avertissement pollue la
    // sortie sans rien apprendre.
    silent: false,
    testTimeout: 120_000,
  },
});
