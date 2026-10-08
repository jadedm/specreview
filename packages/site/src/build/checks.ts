// Everything checked before VitePress runs, and the export it runs on. Each
// failure names the file or the argument, so a product repo's CI log says
// what to fix.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git } from './manifest.js';

export class BuildError extends Error {}

// A bare lowercase repo name: the site's path under the hub.
const REPO = /^[a-z0-9._-]{1,100}$/;
// The hub's router takes only these characters in a path segment, and keeps
// _api and _history for itself. A leading dot is refused too: dot files are
// never part of a site.
const SEGMENT = /^[A-Za-z0-9_~-][A-Za-z0-9._~-]*$/;
const RESERVED = new Set(['_api', '_history']);
// VitePress copies docs/public/ to the site root as is. Only plain files may
// go there: HTML, scripts or SVG would run in the site's origin.
const PUBLIC_TYPES = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'pdf', 'txt', 'csv', 'woff', 'woff2']);
// Written into every output folder, so a later build knows it may empty it.
export const OUTPUT_MARK = '.specreview-output';

export const isInside = (child: string, parent: string) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

// The real path of a folder that may not exist yet: its nearest existing
// parent resolved through any symlink, plus the rest. Comparing one real path
// with one unresolved path would miss /var against /private/var.
export const realOf = (p: string): string => {
  const abs = path.resolve(p);
  if (existsSync(abs)) return realpathSync.native(abs);
  const parent = path.dirname(abs);
  return parent === abs ? abs : path.join(realOf(parent), path.basename(abs));
};

export type Paths = { root: string; docs: string; out: string };

export const checkArguments = (repo: string, paths: Paths) => {
  if (!REPO.test(repo) || repo === '.' || repo === '..') {
    throw new BuildError(`--repo must be the repository's lowercase name, got "${repo}"`);
  }
  if (!existsSync(paths.docs) || !statSync(paths.docs).isDirectory()) {
    throw new BuildError(`--docs ${paths.docs} is not a folder`);
  }
  const root = realpathSync.native(paths.root);
  const docs = realpathSync.native(paths.docs);
  const out = realOf(paths.out);
  if (!isInside(docs, root)) throw new BuildError('--docs must be inside the repository');
  // --out is emptied: it must be a folder of its own inside the repo, never
  // the repo, its .git, the docs or anything holding them.
  const outProblem =
    !isInside(out, root) ||
    out === root ||
    isInside(out, path.join(root, '.git')) ||
    isInside(out, docs) ||
    isInside(docs, out);
  if (outProblem) throw new BuildError('--out must be a folder inside the repository, outside the docs folder');
  const used = existsSync(out) && readdirSync(out).length > 0 && !existsSync(path.join(out, OUTPUT_MARK));
  if (used) throw new BuildError(`--out ${paths.out} is not empty and is not an earlier build's output`);
};

// The manifest names HEAD and history needs every version of every page.
export const checkGit = (docs: string) => {
  const inRepo = (() => {
    try {
      return git(docs, ['rev-parse', '--is-inside-work-tree']).trim() === 'true';
    } catch {
      return false;
    }
  })();
  if (!inRepo) throw new BuildError('the docs folder is not in a git repository');
  if (git(docs, ['rev-parse', '--is-shallow-repository']).trim() === 'true') {
    throw new BuildError('the build needs full git history; fetch with depth 0');
  }
};

// The docs folder as committed at HEAD, written to a fresh folder outside the
// repo: no uncommitted, untracked or ignored file can be published, and the
// manifest's commit is exactly what was built. Symlinks and submodules are
// refused: either could bring in content from outside the docs folder.
export const exportDocs = (root: string, docsRel: string): { docs: string; remove: () => void } => {
  const tree = git(root, ['ls-tree', '-r', '-z', 'HEAD', '--', docsRel === '' ? '.' : docsRel]);
  for (const entry of tree.split('\0').filter(Boolean)) {
    const [meta, file] = entry.split('\t');
    const mode = meta.split(' ')[0];
    if (mode === '120000') throw new BuildError(`${file}: symlinks are not allowed in the docs folder`);
    if (mode === '160000') throw new BuildError(`${file}: submodules are not allowed in the docs folder`);
  }
  // Resolved through symlinks (/var is /private/var on macOS), so VitePress's
  // page paths and ours agree.
  const into = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'specreview-docs-')));
  const archive = spawnSync('git', ['archive', '--format=tar', 'HEAD', '--', docsRel === '' ? '.' : docsRel], {
    cwd: root,
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (archive.status !== 0) throw new BuildError(`git archive failed: ${archive.stderr.toString()}`);
  const untar = spawnSync('tar', ['-x', '-C', into], { input: archive.stdout });
  if (untar.status !== 0) throw new BuildError(`unpacking the docs failed: ${untar.stderr.toString()}`);
  return { docs: path.join(into, docsRel), remove: () => rmSync(into, { recursive: true, force: true }) };
};

// Every file of the exported docs, relative to it.
export const filesIn = (docs: string): string[] =>
  readdirSync(docs, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => path.relative(docs, path.join(d.parentPath, d.name)).split(path.sep).join('/'))
    .sort();

const pathProblem = (file: string): string | null => {
  const parts = file.split('/');
  if (!parts.every((p) => SEGMENT.test(p)))
    return 'names may use only letters, digits and . _ ~ -, not start with a dot';
  // What the hub sees: public/ files land at the site root.
  const served = parts[0] === 'public' ? parts.slice(1) : parts;
  if (RESERVED.has(served[0])) return 'the path may not start with _api or _history';
  if (parts[0] !== 'public') return null;
  const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
  if (served.join('/') === 'manifest.json' || !PUBLIC_TYPES.has(ext)) {
    return `public/ takes only ${[...PUBLIC_TYPES].join(', ')} files`;
  }
  return null;
};

export const checkPaths = (files: string[]) => {
  for (const file of files) {
    const why = pathProblem(file);
    if (why) throw new BuildError(`${file}: ${why}`);
  }
};

// Includes are expanded on the raw page before Markdown, even inside code, and
// an included file could change without changing the page's hash. Snippet
// imports, script and style blocks are refused outside code. Vue interpolation
// is not checked here: the renderer escapes braces (config.ts).
const INCLUDE = /<!--\s*@include/;
const OUTSIDE_CODE: [RegExp, string][] = [
  [/^\s*<<<\s/, 'snippet imports (<<<)'],
  [/<script\b/i, 'script blocks'],
  [/<style\b/i, 'style blocks'],
];
const FENCE = /^\s*(`{3,}|~{3,})/;

export const forbiddenIn = (markdown: string): string | null => {
  if (/^\uFEFF?---[^\S\r\n]*\S/.test(markdown))
    return 'front matter in a language other than YAML (---js and the like)';
  if (INCLUDE.test(markdown)) return 'includes (<!--@include)';
  // An open fence closes with the same character, at least as long.
  let fence: string | null = null;
  for (const line of markdown.split('\n')) {
    const marker = FENCE.exec(line)?.[1];
    const closes = marker !== undefined && fence !== null && marker[0] === fence[0] && marker.length >= fence.length;
    if (marker !== undefined && fence === null) {
      fence = marker;
      continue;
    }
    if (closes) {
      fence = null;
      continue;
    }
    if (fence !== null) continue;
    const hit = OUTSIDE_CODE.find(([re]) => re.test(line.replace(/`[^`]*`/g, '')));
    if (hit) return hit[1];
  }
  return null;
};

export const checkMarkdown = (docs: string, files: string[]) => {
  for (const file of files.filter((f) => f.endsWith('.md'))) {
    const found = forbiddenIn(readFileSync(path.join(docs, file), 'utf8'));
    if (found) throw new BuildError(`${file}: ${found} are not allowed in reviewed pages`);
  }
};
