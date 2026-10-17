// Mermaid for drawn diagrams (#102). Its own prebuilt browser files are
// copied into the site as they are, after VitePress builds, rather than
// bundled by Vite on every build (which added about 15 seconds to each). Only
// a site with a mermaid block gets them; the theme imports them by URL from
// the site's own origin, so the CSP's script-src 'self' covers them.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { BuildError, filesIn } from './checks.js';

const packageOf = () => path.dirname(createRequire(import.meta.url).resolve('mermaid/package.json'));
const distOf = () => path.join(packageOf(), 'dist');

// Where the theme imports from, under the site's base (theme/diagrams.ts),
// named for Mermaid's version so an upgrade changes the address: the hub lets
// browsers keep these files a year (#104).
export const MERMAID_VERSION = (
  JSON.parse(readFileSync(path.join(packageOf(), 'package.json'), 'utf8')) as { version: string }
).version;
export const MERMAID_DIR = `assets/mermaid-${MERMAID_VERSION}`;
export const MERMAID_ENTRY = 'mermaid.esm.min.mjs';
const CHUNKS = path.posix.join('chunks', 'mermaid.esm.min');

// VitePress wraps a mermaid fence in div.language-mermaid.
export const hasDiagram = (site: string) =>
  filesIn(site).some(
    (f) => f.endsWith('.html') && readFileSync(path.join(site, f), 'utf8').includes('class="language-mermaid'),
  );

// The entry and its chunks, without source maps.
export const mermaidFiles = (dist = distOf()) => [
  MERMAID_ENTRY,
  ...readdirSync(path.join(dist, CHUNKS))
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => path.posix.join(CHUNKS, f)),
];

// Copied byte for byte: browsers keep these a year under a folder named only
// for Mermaid's version, so changing them in any way (a patch, a rewrite here)
// needs a new folder name too.
export const copyMermaid = (site: string, dist = distOf()) => {
  if (!hasDiagram(site)) return;
  for (const file of mermaidFiles(dist)) {
    const target = path.join(site, MERMAID_DIR, file);
    if (existsSync(target)) throw new BuildError(`${MERMAID_DIR}/${file}: another file of the site is already there`);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(dist, file), target);
  }
};
