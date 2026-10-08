import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.test.jsonc' },
      miniflare: {
        bindings: { TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, 'migrations')) },
      },
    })),
  ],
  // Tests run before the build, so the shared package is read from source.
  resolve: { alias: { '@specreview/shared': path.join(import.meta.dirname, '../shared/src/index.ts') } },
  test: { include: ['test/**/*.test.ts'], setupFiles: ['test/apply-migrations.ts'] },
});
