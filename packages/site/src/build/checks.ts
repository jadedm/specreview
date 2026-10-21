// Everything checked before VitePress runs, and the export it runs on. Each
// failure names the file or the argument, so a product repo's CI log says
// what to fix.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isExcludePattern } from '@specreview/shared';
import matter from 'gray-matter';
import MarkdownIt, { type StateBlock } from 'markdown-it';
import container from 'markdown-it-container';
import { git } from './manifest.js';

export class BuildError extends Error {}

// A bare lowercase repo name: the site's path under the hub.
const REPO = /^[a-z0-9._-]{1,100}$/;
// The hub's router takes only these characters in a path segment, and keeps
// _api, _history and _signin for itself. A leading dot is refused too: dot files are
// never part of a site.
const SEGMENT = /^[A-Za-z0-9_~-][A-Za-z0-9._~-]*$/;
const RESERVED = new Set(['_api', '_history', '_signin']);
// VitePress copies docs/public/ to the site root as is. Only plain files may
// go there: HTML, scripts or SVG would run in the site's origin.
const PUBLIC_TYPES = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'pdf', 'txt', 'csv', 'woff', 'woff2']);
// Elsewhere in the docs folder a file is a page (lowercase .md, the only name
// VitePress and the checks below treat as one) or a type Vite imports as a
// plain asset (#73). Anything else a page could import Vite parses as code;
// csv is safe only in public/, which is copied and never imported.
export const ASSET_TYPES = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'pdf', 'txt', 'woff', 'woff2']);
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
  // the repo, its .git, the docs or anything holding them. With the docs
  // folder at the root (#87) it sits inside it: the build reads HEAD's tree,
  // not the folder, and cli.ts refuses an --out committed there.
  const outProblem =
    !isInside(out, root) ||
    out === root ||
    isInside(out, path.join(root, '.git')) ||
    (docs !== root && isInside(out, docs)) ||
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
  // History reads only 40-hex commit ids (manifest.ts), and the hub takes no other.
  if (git(docs, ['rev-parse', '--show-object-format']).trim() !== 'sha1') {
    throw new BuildError('the repository uses SHA-256 object names; the hub takes SHA-1 (40-hex) commits');
  }
};

// The docs folder as committed at HEAD, written to a fresh folder outside the
// repo: no uncommitted, untracked or ignored file can be published, and the
// manifest's commit is exactly what was built. Symlinks and submodules are
// refused: either could bring in content from outside the docs folder.
const atRootDot = (file: string) => file.split('/')[0].startsWith('.');

// Paths left out of the site (#88), relative to the docs folder: * within one
// name, ** across folders; with no wildcard, a file or a whole folder.
export const MAX_EXCLUDES = 20;

// --exclude and --prototypes (#111) take the same patterns.
export const checkExcludes = (patterns: string[], flag = '--exclude') => {
  if (patterns.length > MAX_EXCLUDES) throw new BuildError(`at most ${MAX_EXCLUDES} ${flag} patterns`);
  for (const p of patterns)
    if (!isExcludePattern(p))
      throw new BuildError(`${flag} ${JSON.stringify(p)}: a path in the docs folder, with * and ** as wildcards`);
};

export const excludedBy = (patterns: string[]) => {
  const tests = patterns.map((raw) => {
    const p = raw.replace(/\/+$/, '');
    if (!p.includes('*')) return (file: string) => file === p || file.startsWith(`${p}/`);
    const pieces = new Map([
      ['**/', '(?:.*/)?'],
      ['**', '.*'],
      ['*', '[^/]*'],
    ]);
    const body = p
      .split(/(\*\*\/|\*\*|\*)/)
      .map((part) => pieces.get(part) ?? part.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
      .join('');
    // A match may be a folder: everything under it goes too.
    const re = new RegExp(`^${body}(?:/.*)?$`);
    return (file: string) => re.test(file);
  });
  return (file: string) => tests.some((t) => t(file));
};

// Prototype files (#111) are left out of the site like excluded ones, but
// are first moved aside, from this same export, into `proto`: one snapshot
// for the site and its prototypes. `excluded` must cover them too.
export const exportDocs = (
  root: string,
  docsRel: string,
  excluded: (file: string) => boolean = () => false,
  prototype: (file: string) => boolean = () => false,
): { docs: string; proto: string; protoFiles: string[]; treeFiles: string[]; remove: () => void } => {
  const inDocs = (file: string) => (docsRel === '' ? file : file.slice(docsRel.length + 1));
  const tree = git(root, ['ls-tree', '-r', '-z', 'HEAD', '--', docsRel === '' ? '.' : docsRel]);
  // From git's list, not the disk: a case-insensitive disk would merge two
  // names that differ only in case.
  const protoFiles: string[] = [];
  const treeFiles: string[] = [];
  for (const entry of tree.split('\0').filter(Boolean)) {
    const [meta, file] = entry.split('\t');
    if (docsRel === '' && atRootDot(file)) continue;
    const mode = meta.split(' ')[0];
    // Published untouched, so a link or a submodule there is refused too.
    if (prototype(inDocs(file)) && mode === '120000')
      throw new BuildError(`${file}: symlinks are not allowed in a prototype folder`);
    if (prototype(inDocs(file)) && mode === '160000')
      throw new BuildError(`${file}: submodules are not allowed in a prototype folder`);
    treeFiles.push(inDocs(file));
    if (prototype(inDocs(file))) protoFiles.push(inDocs(file));
    if (excluded(inDocs(file))) continue;
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
  // With the docs folder at the root, .github, .gitignore and the like are
  // dropped: the hub could never serve a name starting with a dot.
  if (docsRel === '')
    for (const name of readdirSync(into))
      if (name.startsWith('.')) rmSync(path.join(into, name), { recursive: true, force: true });
  // Excluded paths (#88) go before any check sees them, links included (the
  // symlink check above skipped them, so one must not stay to be followed).
  const docs = path.join(into, docsRel);
  const proto = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'specreview-proto-')));
  const remove = () => {
    rmSync(into, { recursive: true, force: true });
    rmSync(proto, { recursive: true, force: true });
  };
  try {
    for (const entry of readdirSync(docs, { recursive: true, withFileTypes: true })) {
      const file = path.relative(docs, path.join(entry.parentPath, entry.name)).split(path.sep).join('/');
      if (entry.isDirectory() || !excluded(file)) continue;
      if (prototype(file) && entry.isFile()) {
        mkdirSync(path.dirname(path.join(proto, file)), { recursive: true });
        renameSync(path.join(docs, file), path.join(proto, file));
      } else rmSync(path.join(docs, file), { force: true });
    }
    // What was set aside must be exactly git's list: a case-insensitive disk
    // can unpack docs/proto/x into docs/Proto/x, and .gitattributes can drop
    // a file from the archive (export-ignore).
    protoFiles.sort();
    caseClash(protoFiles);
    const onDisk = filesIn(proto);
    if (onDisk.length !== protoFiles.length || onDisk.some((f, i) => f !== protoFiles[i]))
      throw new BuildError(
        'the prototype files unpacked differ from those committed (two folders differing only in case, or a file .gitattributes leaves out of the archive)',
      );
  } catch (err) {
    remove();
    throw err;
  }
  return { docs, proto, protoFiles, treeFiles, remove };
};

const caseClash = (files: string[]) => {
  const seen = new Map<string, string>();
  for (const file of files) {
    const other = seen.get(file.toLowerCase());
    if (other) throw new BuildError(`${file} and ${other}: prototype paths may not differ only in case`);
    seen.set(file.toLowerCase(), file);
  }
};

// Prototype files (#111): names the hub's router takes (no leading dot, not
// under _api, _history or _signin), no two differing only in case (one
// would overwrite the other on a case-insensitive disk), and every
// --prototypes pattern matching something (a typo would publish nothing).
export const checkPrototypes = (files: string[], patterns: string[], tree: string[] = files) => {
  for (const file of files) {
    const parts = file.split('/');
    if (!parts.every((p) => SEGMENT.test(p)))
      throw new BuildError(
        `${file}: prototype file names may use only letters, digits and . _ ~ -, not start with a dot`,
      );
    if (RESERVED.has(parts[0])) throw new BuildError(`${file}: the path may not start with _api, _history or _signin`);
    // The hub keeps an older build's assets/ files in the next version (#104),
    // and a site file there would answer before the prototype redirect (#113).
    if (parts[0] === 'assets')
      throw new BuildError(`${file}: a prototype may not be under assets/, which the site uses`);
  }
  caseClash(files);
  // Against every committed file: a pattern whose matches are all excluded
  // still matched something (exclude wins, quietly).
  for (const pattern of patterns)
    if (!tree.some(excludedBy([pattern])))
      throw new BuildError(`--prototypes ${JSON.stringify(pattern)} matches no committed file in the docs folder`);
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
  // VitePress never builds pages under these (assets it copies as usual), so
  // the sidebar would link to nothing.
  if (file.endsWith('.md') && parts.slice(0, -1).some((p) => p === 'dist' || p === 'node_modules'))
    return 'pages under dist or node_modules folders are not built; rename the folder';
  // What the hub sees: public/ files land at the site root.
  const served = parts[0] === 'public' ? parts.slice(1) : parts;
  // A page at the top serves at its name without .md (clean URLs): _signin.md
  // would be /<repo>/_signin.
  const first = served.length === 1 && served[0].endsWith('.md') ? served[0].slice(0, -3) : served[0];
  if (RESERVED.has(first)) return 'the path may not start with _api, _history or _signin';
  const name = parts[parts.length - 1];
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  if (parts[0] === 'public') {
    if (served.join('/') === 'manifest.json' || !PUBLIC_TYPES.has(ext))
      return `public/ takes only ${[...PUBLIC_TYPES].join(', ')} files`;
    return null;
  }
  if (name.endsWith('.md') || ASSET_TYPES.has(ext)) return null;
  return `outside public/, the docs folder takes only .md pages and ${[...ASSET_TYPES].join(', ')} files`;
};

export const checkPaths = (files: string[]) => {
  for (const file of files) {
    const why = pathProblem(file);
    if (why) throw new BuildError(`${file}: ${why}`);
  }
  // A file served at a page's clean URL would answer in its place (#97):
  // guide.txt beside guide.txt.md, or public/guide.txt at the top. Only
  // files published at their own path can: public/ ones, and the PDF and
  // text files a page links (images and fonts are emitted under assets/).
  const pages = new Set(files.filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)));
  const ownPath = (file: string) => file.startsWith('public/') || /\.(pdf|txt)$/i.test(file);
  for (const file of files) {
    const served = file.startsWith('public/') ? file.slice('public/'.length) : file;
    if (ownPath(file) && pages.has(served))
      throw new BuildError(`${file}: it would be served at the address of the page ${served}.md`);
  }
};

// Includes are expanded on the raw page before Markdown, even inside code, and
// an included file could change without changing the page's hash. Snippet
// imports are refused anywhere VitePress would read one (config.ts also turns
// its snippet rule off), script and style blocks outside code. Vue
// interpolation is not checked here: the renderer escapes braces (config.ts).
const INCLUDE = /<!--\s*@include/;
const OUTSIDE_CODE: [RegExp, string][] = [
  [/<script\b/i, 'script blocks'],
  [/<style\b/i, 'style blocks'],
];
// A code block's first word, as markdown-it splits it (on whitespace): the
// language and VitePress's options ({1,3}, :line-numbers=5). VitePress prints
// an unknown language in the build's log word for word, after decoding
// entities, where GitHub would read ##[...] as a workflow command (#79).
const LANGUAGE = /^[A-Za-z0-9_+.#{},:=-]*$/;

// Pages are parsed as VitePress parses them, so code is what markdown-it
// calls code: fences and indented blocks at any nesting, a fence ending with
// the container it is in. The containers are VitePress's own
// (containerPlugin); raw HTML is off, as in the build.
const CONTAINERS = ['tip', 'info', 'warning', 'danger', 'details', 'v-pre', 'raw', 'code-group'];
type ParseEnv = { snippet?: boolean };
// VitePress's snippet rule (snippetPlugin) starts at a block whose first
// three characters are <<<, indented less than four columns. The same test
// runs where a paragraph, list or quote goes on, so a line read as a block
// start in some layout this parse does not share is found too.
const snippetStart = (state: StateBlock, line: number, _end: number, _silent: boolean) => {
  const at = state.bMarks[line] + state.tShift[line];
  if (state.sCount[line] - state.blkIndent < 4 && state.src.startsWith('<<<', at))
    (state.env as ParseEnv).snippet = true;
  return false;
};
const pageParser = new MarkdownIt({ html: false });
// Typed against markdown-it 14 (@types), as markdown-it-emoji is in sidebar.ts.
for (const name of CONTAINERS) pageParser.use(container as unknown as Parameters<typeof pageParser.use>[0], name);
pageParser.block.ruler.before('fence', 'specreview-snippet', snippetStart, {
  alt: ['paragraph', 'reference', 'blockquote', 'list'],
});

export const forbiddenIn = (markdown: string): string | null => {
  if (/^\uFEFF?---[^\S\r\n]*\S/.test(markdown))
    return 'front matter in a language other than YAML (---js and the like)';
  if (INCLUDE.test(markdown)) return 'includes (<!--@include)';
  // VitePress parses what follows the front matter, as gray-matter splits it.
  const { content, matter: front } = matter(markdown);
  const env: ParseEnv = {};
  const tokens = pageParser.parse(content, env);
  if (env.snippet) return 'snippet imports (<<<)';
  const code = new Set<number>();
  for (const token of tokens) {
    if (token.type !== 'fence' && token.type !== 'code_block') continue;
    if (token.type === 'fence' && !LANGUAGE.test(token.info.trim().split(/\s+/)[0]))
      return 'code block languages other than letters, digits and _+.#{},:=-';
    const [from, to] = token.map ?? [0, 0];
    for (let line = from; line < to; line++) code.add(line);
  }
  const outside = [...front.split('\n'), ...content.split('\n').filter((_, line) => !code.has(line))];
  for (const line of outside) {
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
