// pnpm -r skips a package that has no matching script, so a package without
// typecheck, test or build would pass every gate unchecked. This fails instead.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const required = ['typecheck', 'test', 'build'];
const root = path.join(import.meta.dirname, '..', 'packages');
const missing = readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .flatMap((d) => {
    const scripts = JSON.parse(readFileSync(path.join(root, d.name, 'package.json'), 'utf8')).scripts ?? {};
    return required.filter((s) => !scripts[s]).map((s) => `packages/${d.name} has no "${s}" script`);
  });
if (missing.length > 0) {
  console.error(`check-packages failed:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}
console.log(`check-packages ok: every package has ${required.join(', ')}`);
