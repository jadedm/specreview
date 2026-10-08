// Runs at the end of `vitepress build`. Writes:
//   <site>/manifest.json        every page: title, content hash, linked tickets,
//                               section text (for checking quotes), git history,
//                               and the CSP for every response of this version
//   <history>/<sha>/<path>.md   each page's Markdown as it was at each change,
//                               served by the hub to the team only
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  type HistoryEntry,
  isManifest,
  MAX_MANIFEST_BYTES,
  type Manifest,
  type ManifestPage,
  type Section,
} from '@specreview/shared';
import type { SiteConfig } from 'vitepress';

export const TOP_SECTION = '_top';

export type PageMeta = { title: string; issues: number[] };

export const parseIssues = (page: string, value: unknown): number[] => {
  if (value === undefined) return [];
  const valid =
    Array.isArray(value) &&
    value.every((n) => Number.isSafeInteger(n) && n > 0) &&
    new Set(value).size === value.length;
  if (!valid) throw new Error(`${page}: front matter "issues" must be a list of distinct ticket numbers`);
  return value as number[];
};

// Block elements become a space so text from two list items does not run
// together; inline elements (code, strong, links) vanish, matching what a
// reader's selection gives.
const BLOCK = /<\/?(p|li|ul|ol|div|h[1-6]|pre|blockquote|table|tr|td|th|br|hr)\b[^>]*>/gi;
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };

export const textOf = (html: string): string =>
  html
    .replace(BLOCK, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+|#39);/gi, (whole, name: string) => {
      if (name in ENTITIES) return ENTITIES[name];
      if (/^#x/i.test(name)) return String.fromCodePoint(parseInt(name.slice(2), 16));
      if (name.startsWith('#')) return String.fromCodePoint(Number(name.slice(1)));
      return whole;
    })
    .replace(/\u200B/g, '')
    .replace(/\s+/g, ' ')
    .trim();

// The page body is the `vp-doc` element; its end is found by balancing divs.
export const docBodyOf = (html: string): string => {
  const start = html.search(/<div\b[^>]*\bclass="vp-doc\b/);
  if (start < 0) throw new Error('built page has no vp-doc element');
  const tags = /<div\b|<\/div>/g;
  tags.lastIndex = start;
  let depth = 0;
  for (let m = tags.exec(html); m; m = tags.exec(html)) {
    depth += m[0] === '</div>' ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index);
  }
  throw new Error('unbalanced vp-doc element');
};

export const sectionsOf = (body: string): Section[] => {
  const heading = /<h([23]) id="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/g;
  const afterH1 = body.search(/<\/h1>/i);
  const sections: Section[] = [];
  let cursor = afterH1 >= 0 ? body.indexOf('>', afterH1) + 1 : 0;
  let current: Omit<Section, 'text'> = { id: TOP_SECTION, title: '' };
  for (let m = heading.exec(body); m; m = heading.exec(body)) {
    sections.push({ ...current, text: textOf(body.slice(cursor, m.index)) });
    current = { id: m[2], title: textOf(m[3]) };
    cursor = m.index + m[0].length;
  }
  sections.push({ ...current, text: textOf(body.slice(cursor)) });
  return sections.filter((s) => s.id !== TOP_SECTION || s.text.length > 0);
};

// `git log --follow` with name-status: one record per commit that touched the
// file, with the file's path in that commit (renames and copies tracked).
// Merges are compared with their first parent, so a merge that changed the
// page has a record. Only versions inside the docs folder are kept: a page
// moved in from elsewhere in the repo does not publish what it was before.
export type LogEntry = Omit<HistoryEntry, 'hash'> & { repoPath: string };

export const parseGitLog = (log: string, contentPrefix: string): LogEntry[] =>
  log
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean)
    .flatMap((record) => {
      const [header, ...rest] = record.split('\n');
      const [commit, date, author, subject] = header.split('\x1f');
      const change = rest.find((l) => /^[AMRC]/.test(l));
      if (!change) return [];
      const fields = change.split('\t');
      const repoPath = fields[fields.length - 1];
      if (!repoPath.startsWith(contentPrefix)) return [];
      const pr = /\(#(\d+)\)\s*$/.exec(subject ?? '');
      return [
        {
          commit,
          date,
          author,
          pr: pr ? Number(pr[1]) : null,
          repoPath,
          path: repoPath.slice(contentPrefix.length),
        },
      ];
    });

export const inlineScriptHashes = (html: string): string[] =>
  [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1])
    .filter((code) => code.trim().length > 0)
    .map((code) => `'sha256-${createHash('sha256').update(code).digest('base64')}'`);

export const cspFor = (hashes: string[]) =>
  [
    "default-src 'self'",
    `script-src 'self' ${[...new Set(hashes)].sort().join(' ')}`.trim(),
    // 'unsafe-inline' for styles only: Vue renders style attributes on its
    // components (VitePress's layout sets them at runtime), which hashes or
    // nonces cannot cover. Scripts stay hash-only. Reader text never becomes
    // markup (dom.ts), so no reader-controlled style reaches the page.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export const git = (repo: string, args: string[]) =>
  execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const htmlFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((d) => d.isFile() && d.name.endsWith('.html'))
    .map((d) => path.join(d.parentPath, d.name));

export type Collected = Map<string, PageMeta>;

// A path segment the hub's router serves.
const SERVABLE = /^[A-Za-z0-9._~-]+$/;

export const assertManifestSize = (text: string) => {
  const bytes = Buffer.byteLength(text);
  if (bytes > MAX_MANIFEST_BYTES) {
    throw new Error(`manifest is ${bytes} bytes; the hub takes at most ${MAX_MANIFEST_BYTES}`);
  }
};

// The VitePress buildEnd hook for one build. `historyDir` sits beside the
// site output, not in it: old versions are team-only, served by the hub.
// config.srcDir is the export of HEAD's docs; git runs in the repo itself.
export const buildEndFor =
  (collected: Collected, historyDir: string, repo: string, docsRel: string) =>
  (config: SiteConfig): void => {
    const contentPrefix = docsRel === '' ? '' : `${docsRel}/`;
    const pages: Record<string, ManifestPage> = {};

    for (const file of config.pages) {
      const page = file.replace(/\.md$/, '');
      const meta = collected.get(file);
      if (!meta) throw new Error(`${file}: no page data was collected`);
      const source = readFileSync(path.join(config.srcDir, file), 'utf8');
      const html = readFileSync(path.join(config.outDir, `${page}.html`), 'utf8');
      // quotePath off: git would otherwise quote a non-ASCII path and the
      // prefix check would drop that version.
      const log = git(repo, [
        '-c',
        'core.quotePath=false',
        'log',
        '--follow',
        '--diff-merges=first-parent',
        '--name-status',
        '--format=%x1e%H%x1f%aI%x1f%an%x1f%s',
        '--',
        `${contentPrefix}${file}`,
      ]);
      // A version under an old name the hub cannot serve (a space, say) is left out.
      const servable = parseGitLog(log, contentPrefix).filter((e) => e.path.split('/').every((p) => SERVABLE.test(p)));
      const history: HistoryEntry[] = servable.map(({ repoPath, ...entry }) => {
        const old = git(repo, ['show', `${entry.commit}:${repoPath}`]);
        const target = path.join(historyDir, entry.commit, entry.path);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, old);
        return { ...entry, hash: sha256(old) };
      });
      pages[page] = {
        title: meta.title,
        hash: sha256(source),
        issues: meta.issues,
        sections: sectionsOf(docBodyOf(html)),
        history,
      };
    }

    // Every inline script in every built page, the 404 page included.
    const hashes = htmlFiles(config.outDir).flatMap((f) => inlineScriptHashes(readFileSync(f, 'utf8')));
    const manifest: Manifest = {
      commit: git(repo, ['rev-parse', 'HEAD']).trim(),
      builtAt: new Date().toISOString(),
      csp: cspFor(hashes),
      pages,
    };
    if (!isManifest(manifest)) throw new Error('the built manifest is not one the hub would accept');
    const text = JSON.stringify(manifest);
    assertManifestSize(text);
    writeFileSync(path.join(config.outDir, 'manifest.json'), text);
  };
