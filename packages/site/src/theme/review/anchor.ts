import { contextAt, placesIn } from '@specreview/shared';

// A section's text as the build reads it (#38), from the page's DOM, with a
// map back to the DOM: the build's `textOf` turns block elements into a
// space, drops inline tags and zero-width spaces and collapses whitespace, so
// a quote and its context found here are found by the hub the same way.
const BLOCK = new Set([
  'P',
  'LI',
  'UL',
  'OL',
  'DIV',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'PRE',
  'BLOCKQUOTE',
  'TABLE',
  'TR',
  'TD',
  'TH',
  'BR',
  'HR',
]);
// Drawn by the page's script, not in the built text: a drawn diagram and the
// error line under one that failed (its hidden source is in the text). The
// review panel's nodes are outside the page content.
const SKIP = '.sr-diagram, .sr-diagram-error';
const HEADING = /^H[23]$/;
export const TOP_SECTION = '_top';

type Point = { node: Text; offset: number };
export type TextMap = { text: string; at: (Point | null)[] };

// The page content's children that make up a section: after its h2 or h3 up
// to the next one; the top of the page is after the h1, if any.
export const sectionNodes = (root: HTMLElement, id: string): Element[] => {
  const children = [...root.children];
  const start =
    id === TOP_SECTION
      ? children.findIndex((c) => c.tagName === 'H1') + 1
      : children.findIndex((c) => HEADING.test(c.tagName) && c.id === id) + 1;
  if (id !== TOP_SECTION && start === 0) return [];
  const rest = children.slice(start);
  const end = rest.findIndex((c) => HEADING.test(c.tagName));
  return end < 0 ? rest : rest.slice(0, end);
};

export const textMap = (nodes: Node[]): TextMap => {
  const raw: { ch: string; at: Point | null }[] = [];
  const walk = (n: Node) => {
    if (n instanceof Text) {
      for (let i = 0; i < n.data.length; i++)
        if (n.data[i] !== '​') raw.push({ ch: n.data[i], at: { node: n, offset: i } });
      return;
    }
    if (!(n instanceof Element) || n.matches(SKIP)) return;
    const block = BLOCK.has(n.tagName);
    if (block) raw.push({ ch: ' ', at: null });
    for (const child of n.childNodes) walk(child);
    if (block) raw.push({ ch: ' ', at: null });
  };
  for (const n of nodes) walk(n);
  const chars: string[] = [];
  const at: (Point | null)[] = [];
  let gap: Point | null | undefined;
  for (const r of raw) {
    if (/\s/u.test(r.ch)) {
      gap ??= r.at;
      continue;
    }
    if (gap !== undefined && chars.length > 0) {
      chars.push(' ');
      at.push(gap);
    }
    gap = undefined;
    chars.push(r.ch);
    at.push(r.at);
  }
  return { text: chars.join(''), at };
};

// The text either side of a selection inside its section, from the same text
// the hub checks it against.
export const contextOf = (root: HTMLElement, section: string, range: Range) => {
  const map = textMap(sectionNodes(root, section));
  const inside = (p: Point | null) =>
    p !== null && range.comparePoint(p.node, p.offset) === 0 && range.comparePoint(p.node, p.offset + 1) === 0;
  const first = map.at.findIndex(inside);
  if (first < 0) return { prefix: '', suffix: '' };
  const last = map.at.findLastIndex(inside);
  return contextAt(map.text, first, last + 1);
};

// Context is empty for threads posted before #38.
export type Anchor = { heading: string; quote: string; prefix?: string; suffix?: string };

// The one place a thread's quote and context sit in its section, as a DOM
// range; null when there is none or more than one, never a guess. Pass the
// section's map when locating several threads in one section.
export const locate = (
  root: HTMLElement,
  thread: Anchor,
  map: TextMap = textMap(sectionNodes(root, thread.heading)),
): Range | null => {
  const places = placesIn(thread.quote, thread.prefix ?? '', thread.suffix ?? '', map.text);
  if (places.length !== 1) return null;
  const length = thread.quote.replace(/\s+/gu, ' ').trim().length;
  const start = map.at[places[0]];
  const end = map.at[places[0] + length - 1];
  if (!start || !end) return null;
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset + 1);
  return range;
};
