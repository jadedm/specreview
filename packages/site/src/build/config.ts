// The VitePress config every site is built with. The command (cli.ts) writes
// a throwaway VitePress root whose config calls this, so a product repo holds
// only Markdown.
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { UserConfig } from 'vitepress';
import { filesIn, isInside } from './checks.js';
import { buildEndFor, type Collected, parseIssues } from './manifest.js';
import { readPage, sidebarOf } from './sidebar.js';

// A product repo has no node_modules: the Markdown pages it compiles import
// Vue, so Vue resolves to the copy this package depends on.
const vueDir = path.dirname(createRequire(import.meta.url).resolve('vue/package.json'));
const packageDir = realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
// The theme imports the shared package, which in this workspace is a symlink
// to a folder outside any node_modules.
const sharedDir = realpathSync(path.dirname(createRequire(import.meta.url).resolve('@specreview/shared/package.json')));

export type SiteOptions = {
  repo: string;
  // The exported docs folder (checks.ts exportDocs), and where it lives in the repo.
  docs: string;
  root: string;
  docsRel: string;
  out: string;
  vpRoot: string;
};

// The markdown-it instance VitePress hands to markdown.config.
type MarkdownIt = Parameters<NonNullable<NonNullable<UserConfig['markdown']>['config']>>[0];

export const siteDirOf = (out: string) => path.join(out, 'site');
export const historyDirOf = (out: string) => path.join(out, 'history');

// Vue compiles every page as a template, so {{ }} in page text would run in
// every reader's browser. Braces in text and inline code are written as
// entities, which Vue shows as braces and never interpolates. Fenced code is
// already v-pre in VitePress.
const escapeBraces = (html: string) => html.replace(/\{/g, '&#123;').replace(/\}/g, '&#125;');
export const noInterpolation = (md: MarkdownIt) => {
  for (const rule of ['text', 'code_inline'] as const) {
    const original = md.renderer.rules[rule];
    md.renderer.rules[rule] = (tokens, idx, options, env, self) =>
      escapeBraces(original ? original(tokens, idx, options, env, self) : md.utils.escapeHtml(tokens[idx].content));
  }
};

// A page may only use files inside the docs folder: an image or import that
// reaches outside it (another repo file, a runner file) is refused, so nothing
// the page hash does not cover is published. VitePress, Vue and this package's
// theme are allowed.
export const confineTo = (allowed: string[]) => ({
  name: 'specreview-confine',
  enforce: 'pre' as const,
  load(id: string) {
    const file = id.split('?')[0];
    if (file.startsWith('\0') || !path.isAbsolute(file)) return null;
    const real = (() => {
      try {
        return realpathSync(file);
      } catch {
        return null;
      }
    })();
    if (real === null || real.includes(`${path.sep}node_modules${path.sep}`)) return null;
    if (allowed.some((dir) => isInside(real, dir))) return null;
    throw new Error(`${file}: a page may only use files inside the docs folder`);
  },
});

export const siteConfig = ({ repo, docs, root, docsRel, out, vpRoot }: SiteOptions): UserConfig => {
  const pages = filesIn(docs)
    .filter((f) => f.endsWith('.md'))
    .map((f) => readPage(docs, f));
  for (const p of pages) parseIssues(p.file, p.issues);
  const collected: Collected = new Map();
  return {
    title: pages.find((p) => p.file === 'index.md')?.title ?? repo,
    base: `/${repo}/`,
    srcDir: docs,
    outDir: siteDirOf(out),
    cacheDir: path.join(out, '.cache'),
    cleanUrls: true,
    lastUpdated: false,
    // No colour-scheme switch: it adds an inline script and a toggle nobody needs here.
    appearance: false,
    // Pages are Markdown only; raw HTML in a page would bypass the review UI's text-only rule.
    markdown: { html: false, config: noInterpolation },
    themeConfig: {
      sidebar: sidebarOf(pages),
      outline: { level: [2, 3] },
    },
    transformPageData(pageData) {
      collected.set(pageData.relativePath, {
        title: pageData.title,
        issues: parseIssues(pageData.relativePath, pageData.frontmatter.issues),
      });
    },
    buildEnd: buildEndFor(collected, historyDirOf(out), root, docsRel),
    vite: {
      resolve: { alias: { vue: vueDir } },
      plugins: [confineTo([realpathSync(docs), packageDir, sharedDir, realpathSync(vpRoot)])],
    },
  };
};
