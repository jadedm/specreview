import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Tests run before the build, so the shared package is read from source.
const alias = { '@specreview/shared': path.join(import.meta.dirname, '../shared/src/index.ts') };

export default defineConfig({
  test: {
    projects: [
      // The Worker, in workerd with a local D1.
      {
        plugins: [
          cloudflareTest(async () => ({
            wrangler: { configPath: './wrangler.test.jsonc' },
            miniflare: {
              bindings: { TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, 'migrations')) },
            },
          })),
        ],
        resolve: { alias },
        test: { name: 'worker', include: ['test/**/*.test.ts'], setupFiles: ['test/apply-migrations.ts'] },
      },
      // The setup and deploy scripts, in Node.
      { resolve: { alias }, test: { name: 'deploy', include: ['deploy/**/*.test.ts'], environment: 'node' } },
    ],
  },
});
