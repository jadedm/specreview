// pnpm -r skips a package that has no matching script, so a package without
// typecheck, test or build would pass every gate unchecked. This fails instead.
//
// Licences (decided 9 Oct 2026, sandbox#56): the hub, the part a hosted
// version would run, is AGPL-3.0 with the official GNU text as its LICENSE;
// every other package is MIT under the root LICENSE. Each package says which.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const required = ['typecheck', 'test', 'build'];
const AGPL = new Set(['hub']);
// SHA-256 of https://www.gnu.org/licenses/agpl-3.0.txt.
const AGPL_TEXT_SHA256 = '0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0';
const root = path.join(import.meta.dirname, '..', 'packages');

const problems = [];
for (const d of readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory())) {
  const at = `packages/${d.name}`;
  const manifest = path.join(root, d.name, 'package.json');
  if (!existsSync(manifest)) {
    problems.push(`${at} has no package.json`);
    continue;
  }
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
  for (const s of required.filter((s) => !(pkg.scripts ?? {})[s])) problems.push(`${at} has no "${s}" script`);
  const want = AGPL.has(d.name) ? 'AGPL-3.0-only' : 'MIT';
  if (pkg.license !== want) problems.push(`${at} must declare "license": "${want}"`);
  if (!AGPL.has(d.name)) continue;
  const own = path.join(root, d.name, 'LICENSE');
  const sha = existsSync(own) ? createHash('sha256').update(readFileSync(own)).digest('hex') : null;
  if (sha !== AGPL_TEXT_SHA256) problems.push(`${at}/LICENSE must be the unmodified AGPL-3.0 text from gnu.org`);
}
if (problems.length > 0) {
  console.error(`check-packages failed:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`check-packages ok: every package has ${required.join(', ')} and declares its licence`);
