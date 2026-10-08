import { normalise } from '@specreview/shared';

export const TOP_SECTION = '_top';
const MAX_QUOTE = 1_000;

// The block inside the page content that holds a node: the direct child of
// the content root it sits under.
const blockOf = (root: HTMLElement, node: Node | null): Element | null => {
  let current: Node | null = node;
  while (current && current.parentNode !== root) current = current.parentNode;
  return current instanceof Element ? current : null;
};

// The nearest h2 or h3 at or before the block, or the top of the page.
export const sectionIdBefore = (block: Element | null): string => {
  for (let at: Element | null = block; at; at = at.previousElementSibling) {
    if (/^H[23]$/.test(at.tagName) && at.id) return at.id;
  }
  return TOP_SECTION;
};

type Picked = { quote: string; section: string; rect: DOMRect };

// A selection counts only when it is inside the page text, within one
// section, not inside a heading, and not too long to quote.
export const sectionOfSelection = (root: HTMLElement, selection: Selection | null): Picked | null => {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const start = blockOf(root, range.startContainer);
  const end = blockOf(root, range.endContainer);
  if (!start || !end) return null;
  if (/^H[1-6]$/.test(start.tagName) || /^H[1-6]$/.test(end.tagName)) return null;
  if (start.closest('[id^="rv-"]') || end.closest('[id^="rv-"]')) return null;
  const section = sectionIdBefore(start);
  if (sectionIdBefore(end) !== section) return null;
  const quote = normalise(selection.toString());
  if (quote.length === 0 || quote.length > MAX_QUOTE) return null;
  return { quote, section, rect: range.getBoundingClientRect() };
};
