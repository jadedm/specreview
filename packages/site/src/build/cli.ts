#!/usr/bin/env node
// specreview-site build --repo <name> [--docs docs] [--out .specreview] [--exclude <path>]...
// Builds a repo's docs folder, as committed at HEAD, into <out>/site and
// <out>/history for the hub.
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import MarkdownIt from 'markdown-it';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'vitepress';
import {
  BuildError,
  checkArguments,
  checkExcludes,
  checkGit,
  checkMarkdown,
  checkPaths,
  checkPrototypes,
  excludedBy,
  exportDocs,
  filesIn,
  OUTPUT_MARK,
  realOf,
} from './checks.js';
import { siteShape } from './config.js';
import { git } from './manifest.js';
import { copyMermaid } from './mermaid.js';

const USAGE =
  'usage: specreview-site build --repo <name> [--docs docs] [--out .specreview] [--exclude <path>]... [--prototypes <path>]...';
const here = path.dirname(fileURLToPath(import.meta.url));

// VitePress copies only the files a page imports (images, fonts) and
// public/; a plain link to a PDF or a text file beside a page would 404
// (#97). The PDF and text files pages link to are copied to their own path,
// and nothing else: a repo's other text files (requirements.txt, an internal
// PDF) are not published by sitting in the docs folder. Images and fonts
// are VitePress's to emit. A file meeting another at one path is refused,
// never silently dropped. Excluded paths (#88) are gone from the export.
export const LINKED_TYPES = new Set(['pdf', 'txt']);
const extOf = (file: string) => file.slice(file.lastIndexOf('.') + 1).toLowerCase();

// Every docs-relative file a page links to with a relative link: resolved
// from the page's folder, as the browser does from the page's clean URL.
const linkedFrom = (docs: string, files: string[]) => {
  const md = new MarkdownIt();
  const linked = new Set<string>();
  for (const page of files.filter((f) => f.endsWith('.md'))) {
    const dir = path.posix.dirname(page);
    // The body only: a link written in front matter (a title) is shown as text.
    for (const block of md.parse(matter(readFileSync(path.join(docs, page), 'utf8')).content, {}))
      for (const token of block.children ?? []) {
        const href = token.type === 'link_open' ? String(token.attrGet('href') ?? '') : '';
        if (!href || /^[a-z][a-z0-9+.-]*:|^[#/]/i.test(href)) continue;
        const target = (() => {
          try {
            return decodeURI(href.replace(/[?#].*$/, ''));
          } catch {
            return null;
          }
        })();
        if (target) linked.add(path.posix.normalize(path.posix.join(dir, target)));
      }
  }
  return linked;
};

export const copyLinkedAssets = (docs: string, site: string) => {
  const files = filesIn(docs);
  const linked = linkedFrom(docs, files);
  for (const file of files) {
    if (file.startsWith('public/') || !LINKED_TYPES.has(extOf(file)) || !linked.has(file)) continue;
    const target = path.join(site, file);
    if (existsSync(target)) throw new BuildError(`${file}: another file of the site is already published at /${file}`);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(docs, file), target);
  }
};

// The hub takes an upload of at most 5000 files and 25 MB (packages/hub
// publish.ts); the site, its history and its prototypes count together, and
// so does the multipart framing: per part a boundary, a Content-Disposition
// carrying the name twice (field and file name), a Content-Type and line
// breaks, counted generously as 256 bytes plus twice the name.
export const MAX_BUNDLE_FILES = 5000;
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const checkBundle = (out: string) => {
  const parts = ['site', 'history', 'proto'].flatMap((top) =>
    existsSync(path.join(out, top))
      ? filesIn(path.join(out, top)).map((f) => ({ name: `${top}/${f}`, file: path.join(out, top, f) }))
      : [],
  );
  const bytes = parts.reduce((sum, p) => sum + statSync(p.file).size + 256 + 2 * Buffer.byteLength(p.name), 0);
  if (parts.length > MAX_BUNDLE_FILES)
    throw new BuildError(`the build has ${parts.length} files; the hub takes at most ${MAX_BUNDLE_FILES}`);
  if (bytes > MAX_UPLOAD_BYTES)
    throw new BuildError(
      `the build would upload ${(bytes / 1024 / 1024).toFixed(1)} MB; the hub takes at most ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`,
    );
};

export const runBuild = async (argv: string[], cwd = process.cwd()) => {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      docs: { type: 'string', default: 'docs' },
      out: { type: 'string', default: '.specreview' },
      exclude: { type: 'string', multiple: true, default: [] },
      prototypes: { type: 'string', multiple: true, default: [] },
    },
  });
  if (positionals[0] !== 'build' || positionals.length !== 1 || !values.repo) throw new BuildError(USAGE);
  checkExcludes(values.exclude);
  checkExcludes(values.prototypes, '--prototypes');
  // Prototype folders (#111) are left out of the site as excluded paths are,
  // and published untouched; a path both excluded and listed stays out.
  const leftOut = [...values.exclude, ...values.prototypes];
  const isExcluded = excludedBy(values.exclude);
  const isPrototype = (file: string) => excludedBy(values.prototypes)(file) && !isExcluded(file);
  const docsArg = path.resolve(cwd, values.docs);
  const out = path.resolve(cwd, values.out);
  if (!existsSync(docsArg)) throw new BuildError(`--docs ${values.docs} is not a folder`);
  // The repository is the one the command runs in.
  checkGit(cwd);
  const root = realpathSync.native(git(cwd, ['rev-parse', '--show-toplevel']).trim());
  // With the docs folder at the root, a committed --out would be published:
  // said before checkArguments, which would only call it not empty.
  const atRoot = realpathSync.native(docsArg) === root;
  const outRel = path.relative(root, realOf(out)).split(path.sep).join('/');
  const committed =
    atRoot &&
    outRel !== '' &&
    !outRel.startsWith('..') &&
    git(root, ['ls-tree', '--name-only', 'HEAD', '--', outRel]).trim() !== '';
  if (committed)
    throw new BuildError(
      `--out ${values.out} is committed in the repository; with the docs folder at the root it would be published`,
    );
  checkArguments(values.repo, { root, docs: docsArg, out });
  const docsRel = path.relative(root, realpathSync.native(docsArg)).split(path.sep).join('/');

  const exported = exportDocs(root, docsRel, excludedBy(leftOut), isPrototype);
  try {
    const files = filesIn(exported.docs);
    // The home page is index.md, or a README.md at the top when there is none (#87).
    const home = files.includes('index.md') ? 'index.md' : files.includes('README.md') ? 'README.md' : null;
    if (!home) throw new BuildError(`${values.docs}/index.md or README.md is required, committed at HEAD`);
    checkPaths(files);
    const protoFiles = exported.protoFiles;
    checkPrototypes(protoFiles, values.prototypes, exported.treeFiles);
    const prototypes = protoFiles.map((file) => ({
      path: file,
      hash: createHash('sha256')
        .update(readFileSync(path.join(exported.proto, file)))
        .digest('hex'),
    }));
    checkMarkdown(exported.docs, files);
    // Front matter, titles and the sidebar, checked before VitePress runs.
    siteShape(exported.docs, values.repo, home);

    // A fresh output every time, so nothing from an earlier build survives;
    // checkArguments allowed emptying it.
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, OUTPUT_MARK), 'Written by specreview-site build; emptied by the next build.\n');
    const vpRoot = path.join(out, '.root');
    mkdirSync(path.join(vpRoot, '.vitepress', 'theme'), { recursive: true });
    const options = {
      repo: values.repo,
      docs: exported.docs,
      root,
      docsRel,
      out,
      vpRoot,
      home,
      exclude: leftOut,
      prototypes,
    };
    writeFileSync(
      path.join(vpRoot, '.vitepress', 'config.mjs'),
      `import { siteConfig } from ${JSON.stringify(path.join(here, 'config.js'))};\n` +
        `export default siteConfig(${JSON.stringify(options)});\n`,
    );
    writeFileSync(
      path.join(vpRoot, '.vitepress', 'theme', 'index.mjs'),
      `export { default } from ${JSON.stringify(path.join(here, '..', 'theme', 'index.js'))};\n`,
    );
    try {
      await build(vpRoot);
      copyLinkedAssets(exported.docs, path.join(out, 'site'));
      copyMermaid(path.join(out, 'site'));
      if (protoFiles.length > 0) cpSync(exported.proto, path.join(out, 'proto'), { recursive: true });
      // The hub sends a docs-host request for a prototype path to the
      // prototype hostname only when no site file answers it (#113).
      for (const file of protoFiles)
        for (const served of [file, `${file}.html`, `${file}/index.html`])
          if (existsSync(path.join(out, 'site', served)))
            throw new BuildError(
              `${file}: the site also serves ${served} at that address, so links could never reach the prototype`,
            );
      checkBundle(out);
    } catch (err) {
      // A failed build leaves no half-written site behind.
      rmSync(path.join(out, 'site'), { recursive: true, force: true });
      rmSync(path.join(out, 'history'), { recursive: true, force: true });
      rmSync(path.join(out, 'proto'), { recursive: true, force: true });
      throw err;
    } finally {
      rmSync(vpRoot, { recursive: true, force: true });
      rmSync(path.join(out, '.cache'), { recursive: true, force: true });
    }
  } finally {
    exported.remove();
  }
  if (!existsSync(path.join(out, 'site', 'manifest.json'))) throw new BuildError('the build wrote no manifest');
  return { site: path.join(out, 'site'), history: path.join(out, 'history') };
};

// Run directly or through the npm bin symlink, not when imported by a test.
const isMain =
  process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
// What this prints lands in the caller's job log, where GitHub reads a line
// starting with :: as a workflow command and ##[ as the older form anywhere.
// File names and errors come from the repo, so every :: and ## is broken up
// (line breaks are kept: no line can then start a command). The publish
// action does the same (packages/action/src/publish.ts).
const logSafe = (text: string) => text.replace(/:(?=:)/g, ': ').replace(/#(?=#)/g, '# ');
if (isMain) {
  runBuild(process.argv.slice(2)).then(
    ({ site, history }) => console.error(logSafe(`built ${site} and ${history}`)),
    (err: unknown) => {
      console.error(
        logSafe(
          err instanceof BuildError ? err.message : err instanceof Error ? (err.stack ?? err.message) : String(err),
        ),
      );
      process.exit(1);
    },
  );
}
