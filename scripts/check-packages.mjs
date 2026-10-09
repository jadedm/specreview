// pnpm -r skips a package that has no matching script, so a package without
// typecheck, test or build would pass every gate unchecked. This fails instead.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const required = ['typecheck', 'test', 'build'];
const root = path.join(import.meta.dirname, '..', 'packages');
const missing = readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .flatMap((d) => {
    const scripts = JSON.parse(readFileSync(path.join(root, d.name, 'package.json'), 'utf8')).scripts ?? {};
    return required.filter((s) => !scripts[s]).map((s) => `packages/${d.name} has no "${s}" script`);
  });
// Licences (decided 9 Oct 2026, sandbox#56): the hub, the part a hosted
// version would run, is AGPL-3.0 with its own LICENSE file; every other
// package is MIT under the root LICENSE. Each package says which.
const AGPL = new Set(['hub']);
for (const d of readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory())) {
  const pkg = JSON.parse(readFileSync(path.join(root, d.name, 'package.json'), 'utf8'));
  const want = AGPL.has(d.name) ? 'AGPL-3.0-only' : 'MIT';
  if (pkg.license !== want) missing.push(`packages/${d.name} must declare "license": "${want}"`);
  const own = path.join(root, d.name, 'LICENSE');
  if (AGPL.has(d.name) && !existsSync(own)) missing.push(`packages/${d.name}/LICENSE (the AGPL-3.0 text) is missing`);
}
if (missing.length > 0) {
  console.error(`check-packages failed:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}
console.log(`check-packages ok: every package has ${required.join(', ')}`);
