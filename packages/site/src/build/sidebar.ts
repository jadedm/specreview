// The sidebar, from the docs folder: each folder is a group, each page an
// item. A page's text is its front-matter title, else its first heading,
// else its file name. Order is front-matter `order`, then title, then path.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import MarkdownIt from 'markdown-it';
import { full as emoji } from 'markdown-it-emoji';
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

// The first level-one heading's text, read as VitePress reads a page's
// title (#129: its titlePlugin, 1.6.4): the first h1 anywhere in the parsed
// page, a quote or list included, setext or ATX, and of its inline parts
// only the text and inline code, so **bold** and links read as their text
// and an image-only heading as none. HTML is off, as the site
// builds it. The emoji plugin is VitePress's own (markdown-it-emoji, full).
// As VitePress sets its parser: links found in text, no fuzzy ones.
const parser = new MarkdownIt({ html: false, linkify: true });
parser.linkify.set({ fuzzyLink: false });
// markdown-it-emoji 3.0.0 (the version VitePress bundles, with markdown-it 14)
// calls md.utils.assign and md.utils.has, which markdown-it 15 dropped:
// they were Object.assign and Object.hasOwn. (utils is shared by every
// markdown-it 15 instance in the build; the two only add what 14 had.)
Object.assign(parser.utils, { assign: Object.assign, has: Object.hasOwn });
parser.use(emoji as unknown as Parameters<typeof parser.use>[0]);
// The inline parts a title keeps, joined as plain text (#141): markdown-it
// decodes an entity or an escape where it is one, and inline code keeps what
// was typed, so `&amp;` in code stays as written while A &amp; B reads A & B.
// VitePress keeps the same parts as HTML text; the build hands it this text
// (transformPageData in config.ts), so every view of a title agrees.
type Inline = { type: string; content: string };
const textOf = (children: Inline[] | null | undefined): string | undefined => {
  const text = (children ?? [])
    .filter((t) => t.type === 'text' || t.type === 'code_inline' || t.type === 'emoji')
    .map((t) => t.content)
    .join('')
    .trim();
  return text === '' ? undefined : text;
};
const firstHeading = (markdown: string): string | undefined => {
  const tokens = parser.parse(markdown, {});
  const at = tokens.findIndex((t) => t.type === 'heading_open' && t.tag === 'h1');
  return at < 0 ? undefined : textOf(tokens[at + 1]?.children);
};
const inlineText = (source: string): string | undefined => textOf(parser.parseInline(source, {})[0]?.children);

export const titleOf = (
  file: string,
  markdown: string,
  data: Record<string, unknown>,
  untitled = path.posix.basename(file, '.md'),
): string => {
  // A front-matter title is inline Markdown, as VitePress reads it (#141).
  const front = typeof data.title === 'string' ? (inlineText(data.title) ?? '') : '';
  if (front !== '') return front;
  return firstHeading(markdown) ?? untitled;
};

// A page with no title is named after its file (#124); a folder's index page
// after its folder, and the site's home page after the repo, as the hub's
// index names a site with no titled home page. `page` is the page's key, the
// path without `.md` after the README rewrite (#87).
export const untitledName = (page: string, repo: string): string => {
  if (page === 'index') return repo;
  if (page.endsWith('/index')) return path.posix.basename(path.posix.dirname(page));
  return path.posix.basename(page);
};

// A title is shown as text everywhere. The site title goes into an inline
// script as JSON that VitePress does not escape for HTML, so < and > are
// refused rather than trusted to every place a title lands.
const titleProblem = (title: string) => (/[<>]/.test(title) ? 'may not contain < or >' : null);

export const readPage = (docs: string, file: string, untitled?: string): PageInfo & { issues: unknown } => {
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
  const title = titleOf(file, content, data, untitled);
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
