// The generated Prototypes page (#114): one row per published HTML prototype,
// grouped by folder, built from the files actually published so it cannot
// go stale. It is written into the export after the author-page checks, so
// everything taken from a prototype is escaped here.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { decodeHTML } from 'entities';

export const PROTOTYPES_PAGE = 'prototypes.md';
export const PROTOTYPES_LINK = '/prototypes';
// Docs pages the generated page would meet at its address, case aside (a
// case-insensitive disk would write over them). A `.html.md` page would be
// served as /prototypes.html, the generated page's own file; a
// `prototypes.html/` folder would need that file to be a folder, and a
// `prototypes.md/` folder the generated page's source.
const PROTOTYPES_CLASHES = ['prototypes.md', 'prototypes/index.md', 'prototypes.html.md'];
export const clashesWithPrototypesPage = (file: string) => {
  const lower = file.toLowerCase();
  return (
    PROTOTYPES_CLASHES.includes(lower) || lower.startsWith('prototypes.html/') || lower.startsWith('prototypes.md/')
  );
};

const TITLE_LIMIT = 120;

// Markdown shows a backslash-escaped ASCII punctuation mark as itself, so no
// title can make a link, emphasis, heading or tag.
export const markdownText = (s: string) => s.replace(/[!-/:-@[-`{-~]/g, '\\$&');

// Elements whose content is never the document's title: raw text (a script,
// a style, a textarea), content outside the document (a template), and
// foreign content (an inline SVG or MathML has its own <title>).
const SKIPPED = new Set([
  'script',
  'style',
  'textarea',
  'xmp',
  'noembed',
  'noframes',
  'noscript',
  'iframe',
  'template',
  'svg',
  'math',
]);
const TAG_NAME = /<([a-zA-Z][a-zA-Z0-9-]*)(?=[\t\n\f\r />]|$)/y;

// HTML's whitespace between attributes: tab, line feed, form feed, carriage
// return, space; nothing else.
const SPACE = new Set(['\t', '\n', '\f', '\r', ' ']);

// Where the tag starting at `from` ends (just past its >), quotes respected;
// -1 when it never does. As a browser reads attributes (#122): a quote opens
// a value only where the value starts, after an attribute's = and any
// spaces; inside a value written without quotes, a quote or an = is text and
// the value ends at a space or >.
// Self-closing only when the / stands between attributes, not inside a value
// (<svg href=a/> is not self-closing).
const tagEnd = (html: string, from: number): { end: number; selfClosing: boolean } => {
  let quote = '';
  let state: 'name' | 'equals' | 'unquoted' = 'name';
  let slash = false;
  for (let i = from; i < html.length; i++) {
    const c = html[i];
    if (quote !== '') {
      if (c === quote) quote = '';
      continue;
    }
    if (c === '>') return { end: i + 1, selfClosing: slash };
    slash = state === 'name' && c === '/';
    if (state === 'unquoted') {
      if (SPACE.has(c)) state = 'name';
      continue;
    }
    if (state === 'equals') {
      if (SPACE.has(c)) continue;
      if (c === '"' || c === "'") {
        quote = c;
        state = 'name';
      } else state = 'unquoted';
      continue;
    }
    if (c === '=') state = 'equals';
  }
  return { end: -1, selfClosing: false };
};
const endOfTag = (html: string, from: number) => tagEnd(html, from).end;

// Elements that hold markup, so a same-named one can sit inside: their skip
// walks the tags inside (#122), counting nested ones of the same name and
// stepping over comments, CDATA, attribute values and self-closing tags
// (<svg/>); inside a template, raw text children too, which end at their
// first closer as browsers end them. One pass. Known limits, where the scan
// can read a later title instead of the browser's (still escaped text): a
// tag that breaks out of an svg (<p> inside one), an HTML title inside
// foreign content (foreignObject, mtext), and an svg's <style> inside a
// template.
const NESTING = new Set(['svg', 'math', 'template']);
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'xmp', 'noembed', 'noframes', 'noscript', 'iframe', 'title']);
const CLOSER_NAME = /<\/([a-zA-Z][a-zA-Z0-9-]*)(?=[\t\n\f\r />]|$)/y;
const matchingCloser = (html: string, name: string, from: number): number => {
  let depth = 1;
  for (let at = from; ;) {
    const lt = html.indexOf('<', at);
    if (lt < 0) return -1;
    if (html.startsWith('<!--', lt)) {
      const next = afterComment(html, lt);
      if (next < 0) return -1;
      at = next;
      continue;
    }
    // CDATA is a section only in foreign content (svg, math).
    if (name !== 'template' && html.startsWith('<![CDATA[', lt)) {
      const end = html.indexOf(']]>', lt + 9);
      if (end < 0) return -1;
      at = end + 3;
      continue;
    }
    CLOSER_NAME.lastIndex = lt;
    const closing = CLOSER_NAME.exec(html)?.[1].toLowerCase();
    if (closing !== undefined) {
      if (closing === name && --depth === 0) return lt;
      const end = endOfTag(html, lt);
      if (end < 0) return -1;
      at = end;
      continue;
    }
    TAG_NAME.lastIndex = lt;
    const opening = TAG_NAME.exec(html)?.[1].toLowerCase();
    if (opening === undefined) {
      at = lt + 1;
      continue;
    }
    const { end, selfClosing } = tagEnd(html, lt);
    if (end < 0) return -1;
    if (opening === name && !selfClosing) depth++;
    // Raw text only in HTML content: inside an svg or math a <style> or
    // <script> holds ordinary markup, and its </svg> closes the svg.
    if (name === 'template' && RAW_TEXT.has(opening) && !selfClosing) {
      const close = closerOf(html, opening, end);
      if (close < 0) return -1;
      at = close + 1;
      continue;
    }
    at = end;
  }
};

// The start of the first closing tag for `name` at or after `from`; -1 for none.
const closerOf = (html: string, name: string, from: number) => {
  const closer = new RegExp(`</${name}(?=[\\t\\n\\f\\r />]|$)`, 'gi');
  closer.lastIndex = from;
  return closer.exec(html)?.index ?? -1;
};

// Where scanning resumes after the comment at `lt`; -1 when it never ends.
// <!--> and <!---> are whole comments to a browser.
const afterComment = (html: string, lt: number) => {
  const short = /^<!---?>/.exec(html.slice(lt, lt + 6));
  if (short) return lt + short[0].length;
  const end = html.indexOf('-->', lt + 4);
  return end < 0 ? -1 : end + 3;
};

// What the `<` at `lt` is: the title's text, where scanning resumes, or null
// when the file ends first.
type Step = { title: string } | { next: number } | null;
const stepAt = (html: string, lt: number): Step => {
  if (html.startsWith('<!--', lt)) {
    const next = afterComment(html, lt);
    return next < 0 ? null : { next };
  }
  TAG_NAME.lastIndex = lt;
  const name = TAG_NAME.exec(html)?.[1].toLowerCase();
  if (!name) return { next: lt + 1 };
  const open = endOfTag(html, lt);
  if (open < 0) return null;
  if (name === 'title') {
    const close = closerOf(html, 'title', open);
    return close < 0 ? null : { title: html.slice(open, close) };
  }
  if (!SKIPPED.has(name)) return { next: open };
  const close = NESTING.has(name) ? matchingCloser(html, name, open) : closerOf(html, name, open);
  return close < 0 ? null : { next: close + 1 };
};

// The document's title as a browser finds it, read left to right once, so a
// file of any size or shape costs one pass: comments and skipped elements are
// stepped over, and inside the title only its closing tag counts (the content
// is text, tags and all). null when there is none.
const rawTitle = (html: string): string | null => {
  for (let at = 0; ;) {
    const lt = html.indexOf('<', at);
    if (lt < 0) return null;
    const step = stepAt(html, lt);
    if (step === null) return null;
    if ('title' in step) return step.title;
    at = step.next;
  }
};

// The page's title as a browser tab shows it, as text: entities decoded once,
// as browsers do; null when it has none or a blank one.
export const titleIn = (html: string): string | null => {
  const raw = rawTitle(html);
  if (raw === null) return null;
  // Bidi controls go; joiners, soft hyphens and marks stay, as they shape the
  // text (#122: a family emoji, a ZWNJ word); control characters and runs of
  // space become one space. A title with nothing visible is no title.
  const text = decodeHTML(raw)
    .replace(/\p{Bidi_Control}/gu, '')
    .replace(/[\p{Cc}\s]+/gu, ' ')
    .trim();
  if (!/[^\p{Cf}\p{Mn}\p{Me}\s]/u.test(text)) return null;
  return [...text].slice(0, TITLE_LIMIT).join('');
};

// The link a row uses: the docs-root path, a folder (with its slash) for its index.
const linkTo = (file: string) => {
  if (path.posix.basename(file) !== 'index.html') return `/${file}`;
  const folder = path.posix.dirname(file);
  return folder === '.' ? '/' : `/${folder}/`;
};

// A folder's heading without the leading folders every prototype folder
// shares (#136), keeping at least its own name: product/prototypes/admin
// beside product/prototypes/clipper reads admin.
export const headingsFor = (folders: string[]): Map<string, string> => {
  if (folders.length === 0) return new Map();
  const parts = folders.map((f) => f.split('/'));
  const most = Math.min(...parts.map((p) => p.length - 1));
  let shared = 0;
  while (shared < most && parts.every((p) => p[shared] === parts[0][shared])) shared++;
  return new Map(folders.map((f, i) => [f, parts[i].slice(shared).join('/')]));
};

export const prototypesPage = (files: string[], protoDir: string): string => {
  const pages = files.filter((f) => f.endsWith('.html')).sort();
  // Pages at the docs folder's top lead, without a heading.
  const folders = [...new Set(pages.map((f) => path.posix.dirname(f)))].sort(
    (a, b) => Number(b === '.') - Number(a === '.') || (a < b ? -1 : a > b ? 1 : 0),
  );
  const rowsIn = (folder: string) =>
    pages
      .filter((f) => path.posix.dirname(f) === folder)
      .map((f) => {
        const title = titleIn(readFileSync(path.join(protoDir, f), 'utf8')) ?? path.posix.basename(f);
        return `- [${markdownText(title)}](${linkTo(f)})`;
      });
  const headings = headingsFor(folders.filter((f) => f !== '.'));
  const sections = folders.map((folder) =>
    folder === '.'
      ? rowsIn(folder).join('\n')
      : `## ${markdownText(headings.get(folder) ?? folder)}\n\n${rowsIn(folder).join('\n')}`,
  );
  const body = pages.length === 0 ? 'This site publishes no prototype pages.' : sections.join('\n\n');
  return `---\ntitle: Prototypes\n---\n\n# Prototypes\n\nEvery prototype page this site publishes. Each opens on its own.\n\n${body}\n`;
};
