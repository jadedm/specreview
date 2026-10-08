#!/usr/bin/env node
// specreview-site build --repo <name> [--docs docs] [--out .specreview]
// Builds a repo's docs folder, as committed at HEAD, into <out>/site and
// <out>/history for the hub.
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'vitepress';
import {
  BuildError,
  checkArguments,
  checkGit,
  checkMarkdown,
  checkPaths,
  exportDocs,
  filesIn,
  OUTPUT_MARK,
} from './checks.js';
import { git } from './manifest.js';

const USAGE = 'usage: specreview-site build --repo <name> [--docs docs] [--out .specreview]';
const here = path.dirname(fileURLToPath(import.meta.url));

export const runBuild = async (argv: string[], cwd = process.cwd()) => {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      docs: { type: 'string', default: 'docs' },
      out: { type: 'string', default: '.specreview' },
    },
  });
  if (positionals[0] !== 'build' || positionals.length !== 1 || !values.repo) throw new BuildError(USAGE);
  const docsArg = path.resolve(cwd, values.docs);
  const out = path.resolve(cwd, values.out);
  if (!existsSync(docsArg)) throw new BuildError(`--docs ${values.docs} is not a folder`);
  // The repository is the one the command runs in.
  checkGit(cwd);
  const root = realpathSync(git(cwd, ['rev-parse', '--show-toplevel']).trim());
  checkArguments(values.repo, { root, docs: docsArg, out });
  const docsRel = path.relative(root, realpathSync(docsArg)).split(path.sep).join('/');

  const exported = exportDocs(root, docsRel);
  try {
    const files = filesIn(exported.docs);
    if (!files.includes('index.md')) throw new BuildError(`${values.docs}/index.md is required, committed at HEAD`);
    checkPaths(files);
    checkMarkdown(exported.docs, files);

    // A fresh output every time, so nothing from an earlier build survives;
    // checkArguments allowed emptying it.
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, OUTPUT_MARK), 'Written by specreview-site build; emptied by the next build.\n');
    const vpRoot = path.join(out, '.root');
    mkdirSync(path.join(vpRoot, '.vitepress', 'theme'), { recursive: true });
    const options = { repo: values.repo, docs: exported.docs, root, docsRel, out, vpRoot };
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
if (isMain) {
  runBuild(process.argv.slice(2)).then(
    ({ site, history }) => console.error(`built ${site} and ${history}`),
    (err: unknown) => {
      console.error(err instanceof BuildError ? err.message : err);
      process.exit(1);
    },
  );
}
