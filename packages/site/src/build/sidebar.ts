// The sidebar, from the docs folder: each folder is a group, each page an
// item. A page's text is its front-matter title, else its first heading,
// else its file name. Order is front-matter `order`, then title, then path.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { BuildError } from './checks.js';
import { escapeHtml } from './sanitize.js';

const FRONT_MATTER = new Set(['title', 'order', 'issues']);
// A front matter fence with anything after the dashes names a language.
export const FRONT_MATTER_LANGUAGE = /^\uFEFF?---[^\S\r\n]*\S/;
const refuse = () => {
  throw new BuildError('front matter must be YAML');
};

export type SidebarItem = { text: string; link?: string; items?: SidebarItem[] };
type PageInfo = { file: string; title: string; order: number };

// The first level-one heading outside fenced code.
const firstHeading = (markdown: string): string | undefined => {
  let fence: string | null = null;
  for (const line of markdown.split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && fence === null) fence = marker;
    else if (marker && fence !== null && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
    else if (fence === null) {
      const heading = /^#\s+(.+?)\s*#*\s*$/.exec(line)?.[1];
      if (heading) return heading;
    }
  }
  return undefined;
};

export const titleOf = (file: string, markdown: string, data: Record<string, unknown>): string => {
  if (typeof data.title === 'string' && data.title.trim() !== '') return data.title.trim();
  return firstHeading(markdown) ?? path.posix.basename(file, '.md');
};

// A title is shown as text everywhere. The site title goes into an inline
// script as JSON that VitePress does not escape for HTML, so < and > are
// refused rather than trusted to every place a title lands.
const titleProblem = (title: string) => (/[<>]/.test(title) ? 'may not contain < or >' : null);

export const readPage = (docs: string, file: string): PageInfo & { issues: unknown } => {
  const raw = readFileSync(path.join(docs, file), 'utf8');
  // Front matter in another language (---js) is evaluated by the parser:
  // refused before any parsing. The same check runs before VitePress (checks.ts).
  if (FRONT_MATTER_LANGUAGE.test(raw)) throw new BuildError(`${file}: front matter must be YAML`);
  const { data, content } = matter(raw, { engines: { js: refuse, javascript: refuse } });
  // VitePress acts on other front matter: head adds scripts and tags, layout
  // and hero render HTML. A reviewed page takes only these.
  const unknown = Object.keys(data).filter((k) => !FRONT_MATTER.has(k));
  if (unknown.length > 0) {
    throw new BuildError(
      `${file}: front matter may hold only ${[...FRONT_MATTER].join(', ')}; found ${unknown.join(', ')}`,
    );
  }
  if (data.order !== undefined && (typeof data.order !== 'number' || !Number.isFinite(data.order))) {
    throw new BuildError(`${file}: front matter "order" must be a number`);
  }
  const title = titleOf(file, content, data);
  const problem = titleProblem(title);
  if (problem) throw new BuildError(`${file}: the title ${problem}`);
  return {
    file,
    title,
    order: typeof data.order === 'number' ? data.order : Number.POSITIVE_INFINITY,
    issues: data.issues,
  };
};

const byOrder = (a: PageInfo, b: PageInfo) =>
  a.order - b.order || a.title.localeCompare(b.title) || a.file.localeCompare(b.file);

// The address of a page under the base, as clean URLs serve it.
export const linkOf = (file: string) => {
  const page = file.replace(/\.md$/, '');
  if (page === 'index') return '/';
  if (page.endsWith('/index')) return `/${page.slice(0, -'index'.length)}`;
  return `/${page}`;
};

export const sidebarOf = (pages: PageInfo[]): SidebarItem[] => {
  const build = (folder: string): SidebarItem[] => {
    const here = pages.filter((p) => path.posix.dirname(p.file) === (folder || '.'));
    const own = here.filter((p) => path.posix.basename(p.file) !== 'index.md' || folder === '').sort(byOrder);
    // Folders directly inside this one that hold at least one page.
    const depth = folder === '' ? 0 : folder.split('/').length;
    const inside = pages.map((p) => p.file.split('/')).filter((parts) => parts.length > depth + 1);
    const subfolders = [
      ...new Set(
        inside
          .filter((parts) => parts.slice(0, depth).join('/') === folder)
          .map((parts) => parts.slice(0, depth + 1).join('/')),
      ),
    ].sort();
    const groups = subfolders.map((sub): SidebarItem & { sort: PageInfo } => {
      const index = pages.find((p) => p.file === `${sub}/index.md`);
      const sort = index ?? { file: `${sub}/`, title: path.posix.basename(sub), order: Number.POSITIVE_INFINITY };
      return { text: escapeHtml(sort.title), ...(index ? { link: linkOf(index.file) } : {}), items: build(sub), sort };
    });
    const items: (SidebarItem & { sort: PageInfo })[] = [
      // VitePress renders sidebar text as HTML: titles are escaped.
      ...own.map((p) => ({ text: escapeHtml(p.title), link: linkOf(p.file), sort: p })),
      ...groups,
    ];
    // The site's own index leads; the rest by order, title, path.
    return items
      .sort(
        (a, b) => Number(b.sort.file === 'index.md') - Number(a.sort.file === 'index.md') || byOrder(a.sort, b.sort),
      )
      .map(({ sort: _sort, ...item }) => item);
  };
  return build('');
};
