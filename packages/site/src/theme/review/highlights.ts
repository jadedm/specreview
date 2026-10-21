import { onContentUpdated } from 'vitepress';
import { defineComponent, onMounted } from 'vue';
import { locate, sectionNodes, textMap, type TextMap } from './anchor';
import type { Thread } from './api';
import { el } from './dom';

// #38: each open thread's passage is marked in the page with the CSS Custom
// Highlight API, which paints ranges without touching the page's DOM, so
// VitePress's and Mermaid's nodes are left alone. A thread links to its
// passage ("Show in page") and a click on a passage goes to its thread.
// Without the API nothing is marked and the panel works as before.
export const HIGHLIGHT = 'rv-quote';
export const ACTIVE = 'rv-quote-active';
const SHOW_CLASS = 'rv-show';

type Located = { id: string; range: Range };
let threads: Thread[] = [];
let located: Located[] = [];
let active: string | null = null;

const highlights = () =>
  typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight === 'function' ? CSS.highlights : null;
const content = () => document.querySelector<HTMLElement>('.vp-doc > div');
const cardOf = (id: string) =>
  [...document.querySelectorAll<HTMLElement>('.rv-thread')].find((c) => c.dataset.id === id) ?? null;

const paint = () => {
  const registry = highlights();
  if (!registry) return;
  registry.set(HIGHLIGHT, new Highlight(...located.filter((l) => l.id !== active).map((l) => l.range)));
  const current = located.find((l) => l.id === active);
  if (current) registry.set(ACTIVE, new Highlight(current.range));
  else registry.delete(ACTIVE);
  for (const card of document.querySelectorAll<HTMLElement>('.rv-thread[data-active]'))
    card.removeAttribute('data-active');
  if (active) cardOf(active)?.setAttribute('data-active', '');
};

// Looked up when clicked, so a redraw since the button was added is followed.
const show = (id: string) => {
  const l = located.find((x) => x.id === id);
  if (!l) return;
  active = l.id;
  paint();
  const top = l.range.getBoundingClientRect().top + window.scrollY - window.innerHeight / 3;
  window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
};

// A "Show in page" button on each card whose passage was found, and none on
// a card whose passage no longer is.
const linkCards = () => {
  const found = new Set(located.map((l) => l.id));
  for (const button of document.querySelectorAll<HTMLElement>(`.rv-thread .${SHOW_CLASS}`)) {
    const id = button.closest<HTMLElement>('.rv-thread')?.dataset.id;
    if (!highlights() || !id || !found.has(id)) button.remove();
  }
  if (!highlights()) return;
  for (const l of located) {
    const card = cardOf(l.id);
    if (!card || card.querySelector(`.${SHOW_CLASS}`)) continue;
    const button = el('button', { class: `rv-link ${SHOW_CLASS}`, onclick: () => show(l.id) }, 'Show in page');
    card.querySelector('.rv-quote')?.after(button);
  }
};

// Runs when the panel has drawn and when the page's content changes, so
// whichever comes second finds both.
export const refreshHighlights = () => {
  const root = content();
  // One walk of each section, however many threads it holds.
  const maps = new Map<string, TextMap>();
  const mapOf = (r: HTMLElement, heading: string) => {
    if (!maps.has(heading)) maps.set(heading, textMap(sectionNodes(r, heading)));
    return maps.get(heading)!;
  };
  located = root
    ? threads.flatMap((t) => {
        const range = locate(root, t, mapOf(root, t.heading));
        return range ? [{ id: t.id, range }] : [];
      })
    : [];
  if (active && !located.some((l) => l.id === active)) active = null;
  paint();
  linkCards();
};

export const showHighlights = (list: Thread[]) => {
  threads = list.filter((t) => t.state === 'open' && !t.outdated && !t.quoteHidden);
  refreshHighlights();
};

export const clearHighlights = () => {
  threads = [];
  located = [];
  active = null;
  const registry = highlights();
  registry?.delete(HIGHLIGHT);
  registry?.delete(ACTIVE);
};

type Caret = { node: Node; offset: number };
const caretAt = (x: number, y: number): Caret | null => {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  if (doc.caretPositionFromPoint) {
    const p = doc.caretPositionFromPoint(x, y);
    return p ? { node: p.offsetNode, offset: p.offset } : null;
  }
  const r = doc.caretRangeFromPoint?.(x, y);
  return r ? { node: r.startContainer, offset: r.startOffset } : null;
};

// A click on a marked passage goes to its thread; a click that ends a
// selection is left to the comment button, and one on a link or control does
// only what that does.
export const onPassageClick = (event: MouseEvent) => {
  if (located.length === 0 || !highlights()) return;
  if (window.getSelection()?.isCollapsed === false) return;
  if ((event.target as Element | null)?.closest?.('a, button, summary, input, textarea, select')) return;
  const caret = caretAt(event.clientX, event.clientY);
  // Only text in the page: a caret API can answer a text field itself, with
  // an offset into its value.
  if (!caret || !(caret.node instanceof Text) || !content()?.contains(caret.node)) return;
  const hit = located.find((l) => l.range.isPointInRange(caret.node, caret.offset));
  const card = hit && cardOf(hit.id);
  if (!hit || !card) return;
  active = hit.id;
  paint();
  card.setAttribute('tabindex', '-1');
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.focus({ preventScroll: true });
};

// Rendered in the layout's doc-after slot, as the diagrams are: VitePress runs
// onContentUpdated once the page's content is in the DOM.
export const Highlights = defineComponent({
  name: 'Highlights',
  setup() {
    onContentUpdated(refreshHighlights);
    onMounted(refreshHighlights);
    return () => null;
  },
});
