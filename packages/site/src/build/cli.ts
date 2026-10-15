#!/usr/bin/env node
// specreview-site build --repo <name> [--docs docs] [--out .specreview] [--exclude <path>]...
// Builds a repo's docs folder, as committed at HEAD, into <out>/site and
// <out>/history for the hub.
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
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
  excludedBy,
  exportDocs,
  filesIn,
  OUTPUT_MARK,
  realOf,
} from './checks.js';
import { siteShape } from './config.js';
import { git } from './manifest.js';

const USAGE = 'usage: specreview-site build --repo <name> [--docs docs] [--out .specreview] [--exclude <path>]...';
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
    for (const block of md.parse(readFileSync(path.join(docs, page), 'utf8'), {}))
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

export const runBuild = async (argv: string[], cwd = process.cwd()) => {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      docs: { type: 'string', default: 'docs' },
      out: { type: 'string', default: '.specreview' },
      exclude: { type: 'string', multiple: true, default: [] },
    },
  });
  if (positionals[0] !== 'build' || positionals.length !== 1 || !values.repo) throw new BuildError(USAGE);
  checkExcludes(values.exclude);
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

  const exported = exportDocs(root, docsRel, excludedBy(values.exclude));
  try {
    const files = filesIn(exported.docs);
    // The home page is index.md, or a README.md at the top when there is none (#87).
    const home = files.includes('index.md') ? 'index.md' : files.includes('README.md') ? 'README.md' : null;
    if (!home) throw new BuildError(`${values.docs}/index.md or README.md is required, committed at HEAD`);
    checkPaths(files);
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
      exclude: values.exclude,
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
    } catch (err) {
      // A failed build leaves no half-written site behind.
      rmSync(path.join(out, 'site'), { recursive: true, force: true });
      rmSync(path.join(out, 'history'), { recursive: true, force: true });
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
