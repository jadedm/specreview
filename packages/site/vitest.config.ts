import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Tests run before the build, so the shared package is read from source.
  resolve: { alias: { '@specreview/shared': path.join(import.meta.dirname, '../shared/src/index.ts') } },
  test: { include: ['src/**/*.test.ts', 'test/**/*.test.ts'], testTimeout: 120_000, hookTimeout: 180_000 },
});
