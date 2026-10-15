// The VitePress config every site is built with. The command (cli.ts) writes
// a throwaway VitePress root whose config calls this, so a product repo holds
// only Markdown.
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { UserConfig } from 'vitepress';
import { ASSET_TYPES, BuildError, filesIn, isInside } from './checks.js';
import { buildEndFor, type Collected, parseIssues } from './manifest.js';
import { sanitizeRendered } from './sanitize.js';
import { readPage, sidebarOf } from './sidebar.js';

// A product repo has no node_modules: the Markdown pages it compiles import
// Vue, so Vue resolves to the copy this package depends on.
const vueDir = path.dirname(createRequire(import.meta.url).resolve('vue/package.json'));
const packageDir = realpathSync.native(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
// The node_modules tree this package was installed into (where VitePress and
// Vue are), and no other: a file under some other node_modules on the
// machine is still outside the docs.
const nodeModulesOf = (dir: string) => {
  const marker = `${path.sep}node_modules${path.sep}`;
  return dir.slice(0, dir.indexOf(marker) + marker.length - 1);
};
const modulesDir = nodeModulesOf(
  realpathSync.native(path.dirname(createRequire(import.meta.url).resolve('vitepress/package.json'))),
);
// The theme imports the shared package, which in this workspace is a symlink
// to a folder outside any node_modules.
const sharedDir = realpathSync.native(
  path.dirname(createRequire(import.meta.url).resolve('@specreview/shared/package.json')),
);

export type SiteOptions = {
  repo: string;
  // The exported docs folder (checks.ts exportDocs), and where it lives in the repo.
  docs: string;
  root: string;
  docsRel: string;
  out: string;
  vpRoot: string;
  // The home page's source: index.md, or a top-level README.md without one (#87).
  home?: string | null;
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
  // Last, after every VitePress plugin: the whole rendered page is sanitized.
  const render = md.render.bind(md);
  md.render = (src, env) => sanitizeRendered(render(src, env));
  for (const rule of ['text', 'code_inline'] as const) {
    const original = md.renderer.rules[rule];
    md.renderer.rules[rule] = (tokens, idx, options, env, self) =>
      escapeBraces(original ? original(tokens, idx, options, env, self) : md.utils.escapeHtml(tokens[idx].content));
  }
};

// With a README.md home page (#87), a link to it goes to the home page:
// VitePress builds it as index.html, and its own link handling does not
// follow the rewrite. Runs on the parsed page, before VitePress renders links.
export const readmeHome = (md: MarkdownIt) => {
  md.core.ruler.push('specreview-readme-home', (state) => {
    const page = String((state.env as { relativePath?: string }).relativePath ?? '');
    const dir = path.posix.dirname(page);
    for (const block of state.tokens)
      for (const token of block.children ?? []) {
        const href = token.type === 'link_open' ? token.attrGet('href') : null;
        if (!href || /^[a-z][a-z0-9+.-]*:|^[#/]/i.test(href)) continue;
        const [, target, rest] = /^([^?#]*)(.*)$/.exec(href)!;
        if (path.posix.normalize(path.posix.join(dir, target)) !== 'README.md') continue;
        token.attrSet('href', `${path.posix.relative(dir, 'index.md') || 'index.md'}${rest}`);
      }
  });
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
        return realpathSync.native(file);
      } catch {
        return null;
      }
    })();
    if (real === null) return null;
    if (allowed.some((dir) => isInside(real, dir))) return null;
    throw new Error(`${file}: a page may only use files inside the docs folder`);
  },
});

// A file from the docs folder may load only as a page or as a plain asset
// (#73): a query (?raw, ?url, ?worker and the like) or a type Vite does not
// treat as an asset would hand its bytes to Vite as code or as a script to
// emit. checkPaths refuses such files by name; this refuses such uses.
export const docsAsPagesOrAssets = (docs: string) => ({
  name: 'specreview-docs-assets',
  enforce: 'pre' as const,
  load(id: string) {
    const at = id.indexOf('?');
    const file = at < 0 ? id : id.slice(0, at);
    if (file.startsWith('\0') || !path.isAbsolute(file)) return null;
    const real = (() => {
      try {
        return realpathSync.native(file);
      } catch {
        return null;
      }
    })();
    if (real === null || !isInside(real, docs)) return null;
    // A page, as VitePress loads it: bare, or with the Vue compiler's own query.
    if (file.endsWith('.md') && (at < 0 || id.slice(at + 1).startsWith('vue'))) return null;
    const name = path.basename(file);
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
    if (at < 0 && ASSET_TYPES.has(ext)) return null;
    throw new Error(`${path.relative(docs, real)}: a page may use this file only as a plain image or link`);
  },
});

// VitePress runs any string in its site data that starts with this prefix as
// a function, during the build. Titles, headings and folder names all reach
// the site data, so the finished site title and theme config are searched.
const FUNCTION_PREFIX = '_vp-fn_';
export const assertNoFunctionStrings = (value: unknown, where: string): void => {
  if (typeof value === 'string' && value.startsWith(FUNCTION_PREFIX)) {
    throw new BuildError(
      `${where}: "${value.slice(0, 40)}" starts with ${FUNCTION_PREFIX}, which VitePress would run as code`,
    );
  }
  if (Array.isArray(value)) value.forEach((v, i) => assertNoFunctionStrings(v, `${where}[${i}]`));
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertNoFunctionStrings(v, `${where}.${k}`);
  }
};

// The site title and theme config, from the pages: computed by the command
// before VitePress starts (so a refusal is reported as it is) and again here.
export const siteShape = (docs: string, repo: string, home?: string | null) => {
  // A README.md home page is index.md to the sidebar, as VitePress's rewrite makes it.
  const read = filesIn(docs)
    .filter((f) => f.endsWith('.md'))
    .map((f) => readPage(docs, f));
  // Checked under its own name, so an error names the file the author has.
  for (const p of read) parseIssues(p.file, p.issues);
  const pages = read.map((p) => (home === 'README.md' && p.file === 'README.md' ? { ...p, file: 'index.md' } : p));
  const title = pages.find((p) => p.file === 'index.md')?.title ?? repo;
  // The 404 page in plain words (#52): what happened and where to go.
  const notFound = {
    title: 'Page not found',
    quote: "This page doesn't exist. It may have been moved or renamed.",
    linkText: `Go to ${title}`,
    linkLabel: `Go to ${title}`,
  };
  const themeConfig = { sidebar: sidebarOf(pages), outline: { level: [2, 3] as [number, number] }, notFound };
  assertNoFunctionStrings({ title, themeConfig }, 'site');
  return { title, themeConfig };
};

export const siteConfig = ({ repo, docs, root, docsRel, out, vpRoot, home }: SiteOptions): UserConfig => {
  const { title, themeConfig } = siteShape(docs, repo, home);
  const collected: Collected = new Map();
  return {
    title,
    base: `/${repo}/`,
    srcDir: docs,
    // VitePress serves the README as the home page and resolves links to it there.
    ...(home === 'README.md' ? { rewrites: { 'README.md': 'index.md' } } : {}),
    outDir: siteDirOf(out),
    cacheDir: path.join(out, '.cache'),
    cleanUrls: true,
    lastUpdated: false,
    // No colour-scheme switch: it adds an inline script and a toggle nobody needs here.
    appearance: false,
    // Pages are Markdown only; raw HTML in a page would bypass the review UI's text-only rule.
    // {...} attributes would pass Vue directives (@click, :title) to the compiler.
    markdown: {
      html: false,
      attrs: { disable: true },
      config: (md) => {
        if (home === 'README.md') readmeHome(md);
        noInterpolation(md);
      },
    },
    themeConfig,
    transformPageData(pageData) {
      collected.set(pageData.relativePath, {
        title: pageData.title,
        issues: parseIssues(pageData.relativePath, pageData.frontmatter.issues),
      });
    },
    buildEnd: buildEndFor(collected, historyDirOf(out), root, docsRel),
    vite: {
      resolve: { alias: { vue: vueDir } },
      plugins: [
        confineTo([realpathSync.native(docs), packageDir, sharedDir, modulesDir, realpathSync.native(vpRoot)]),
        docsAsPagesOrAssets(realpathSync.native(docs)),
      ],
    },
  };
};
