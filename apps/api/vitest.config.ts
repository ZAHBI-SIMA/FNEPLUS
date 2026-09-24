import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: {
    // NestJS s'appuie sur les décorateurs et les métadonnées de type émises par
    // TypeScript ; esbuild ne les produit pas seul.
    target: 'es2022',
    tsconfigRaw: {
      compilerOptions: {
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        useDefineForClassFields: false,
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Les tests d'intégration partagent une base PostgreSQL et se nettoient
    // mutuellement : ils doivent s'exécuter en série.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
