// @vitest-environment happy-dom
// #38: a thread's passage found in the page and highlighted. Case numbers are
// the ticket's plan.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sectionsOf } from '../../build/manifest';
import { contextOf, locate, sectionNodes, textMap } from './anchor';
import type { Thread } from './api';
import { ACTIVE, clearHighlights, HIGHLIGHT, onPassageClick, showHighlights } from './highlights';

// A built page's body, as VitePress renders plain Markdown: inline markup,
// lists, an entity, a code block with its language label, a table, a quote,
// a zero-width space and a line break.
const ZWSP = String.fromCharCode(0x200b);
const BODY = `<div class="vp-doc"><div>
<h1 id="signup">Signup <a class="header-anchor" href="#signup">#</a></h1>
<p>Top of the page.</p>
<h2 id="limits">Limits <a class="header-anchor" href="#limits">#</a></h2>
<p>One account can own <strong>up to 3</strong> companies, including <a href="/x">ones waiting</a> for approval.</p>
<ul><li>foo</li><li>bar</li></ul>
<p>Fish &amp; chips&nbsp;here.${ZWSP} And <code>code</code>.</p>
<div class="language-ts"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre><code><span>const a = 1;</span>
<span>const b = 2;</span></code></pre></div>
<table><thead><tr><th>Plan</th><th>Price</th></tr></thead><tbody><tr><td>Starter</td><td>Free</td></tr></tbody></table>
<h4 id="rv-1-rollback">RV-1 rollback</h4>
<blockquote><p>A quote.</p></blockquote>
<p>line one<br>line two</p>
<h3 id="again">Again</h3>
<p>the queue holds jobs. the other queue holds jobs. the second queue holds mail.</p>
</div></div>`;

const root = () => document.querySelector<HTMLElement>('.vp-doc > div')!;
const thread = (over: Partial<Thread>): Thread => ({
  id: 't1',
  heading: 'limits',
  quote: 'q',
  prefix: '',
  suffix: '',
  pageHash: 'h',
  author: 'a',
  mine: false,
  body: 'b',
  state: 'open',
  resolvedBy: null,
  resolvedPr: null,
  resolvedAt: null,
  createdAt: '2026-10-21T00:00:00Z',
  outdated: false,
  replies: [],
  ...over,
});
const card = (id: string) => {
  const c = document.createElement('div');
  c.className = 'rv-thread';
  c.dataset.id = id;
  c.innerHTML = '<blockquote class="rv-quote">q</blockquote>';
  document.body.append(c);
  return c;
};

// A stand-in for CSS.highlights and Highlight.
class FakeHighlight {
  ranges: Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}
let registry: Map<string, FakeHighlight>;
const install = () => {
  registry = new Map();
  vi.stubGlobal('CSS', { highlights: registry, escape: (s: string) => s });
  vi.stubGlobal('Highlight', FakeHighlight);
};
const marked = (name = HIGHLIGHT) => (registry.get(name)?.ranges ?? []).map((r) => r.toString());

beforeEach(() => {
  document.body.innerHTML = BODY;
  install();
});
afterEach(() => {
  clearHighlights();
  vi.unstubAllGlobals();
});

describe('38: the section text as the build reads it', () => {
  it("22: the DOM walker's text equals the build's section text for every section", () => {
    const built = sectionsOf(BODY);
    expect(built.map((s) => s.id)).toEqual(['_top', 'limits', 'again']);
    for (const s of built) expect(textMap(sectionNodes(root(), s.id)).text, s.id).toBe(s.text);
  });

  it("19: a drawn diagram and its error line are not in the text; an author's own rv- id is", () => {
    const p = root().querySelector('#limits + p')!;
    p.insertAdjacentHTML(
      'beforeend',
      '<span class="sr-diagram">drawn</span><span class="sr-diagram-error">failed</span>',
    );
    const text = textMap(sectionNodes(root(), 'limits')).text;
    expect(text).not.toMatch(/drawn|failed/);
    expect(text).toContain('RV-1 rollback');
  });
});

describe('38: context of a selection', () => {
  it('1: the text either side, across inline markup, cut to 32 characters', () => {
    const strong = root().querySelector('strong')!.firstChild!;
    const range = document.createRange();
    range.setStart(strong, 0);
    range.setEnd(strong, 'up to 3'.length);
    expect(contextOf(root(), 'limits', range)).toEqual({
      prefix: 'One account can own',
      suffix: 'companies, including ones waitin',
    });
  });
});

describe('38: locating a passage', () => {
  it('10, 14: once in its section, across inline markup or two list items', () => {
    expect(locate(root(), thread({ quote: 'up to 3 companies, including ones' }))?.toString()).toBe(
      'up to 3 companies, including ones',
    );
    expect(locate(root(), thread({ quote: 'foo bar' }))?.toString()).toBe('foobar');
  });

  it('11, 12: twice in its section: context picks one; the same context picks none', () => {
    const second = locate(
      root(),
      thread({ heading: 'again', quote: 'queue', prefix: 'the second', suffix: 'holds mail' }),
    );
    const p = root().querySelector('#again + p')!.textContent!;
    expect(second?.startOffset).toBe(p.lastIndexOf('queue'));
    expect(locate(root(), thread({ heading: 'again', quote: 'queue', suffix: 'holds jobs' }))).toBeNull();
  });

  it('a heading no longer on the page finds nothing', () => {
    expect(locate(root(), thread({ heading: 'gone', quote: 'up to 3' }))).toBeNull();
  });
});

describe('38: highlights', () => {
  it('10, 13: open live threads are marked; resolved, outdated and hidden ones are not', () => {
    showHighlights([
      thread({ id: 'a', quote: 'up to 3' }),
      thread({ id: 'b', quote: 'Fish & chips', state: 'resolved' }),
      thread({ id: 'c', quote: 'A quote', outdated: true }),
      thread({ id: 'd', quote: 'line one', quoteHidden: true }),
    ]);
    expect(marked()).toEqual(['up to 3']);
  });

  it('15: without the highlight API nothing is marked and nothing throws', () => {
    vi.unstubAllGlobals();
    vi.stubGlobal('CSS', {});
    expect(() => showHighlights([thread({ quote: 'up to 3' })])).not.toThrow();
  });

  it('16: "Show in page" on the card marks its passage active', () => {
    const c = card('a');
    window.scrollTo = vi.fn();
    showHighlights([thread({ id: 'a', quote: 'up to 3' })]);
    const button = [...c.querySelectorAll('button')].find((b) => b.textContent === 'Show in page')!;
    expect(button).toBeDefined();
    button.click();
    expect(marked(ACTIVE)).toEqual(['up to 3']);
    expect(marked()).toEqual([]);
    expect(c.hasAttribute('data-active')).toBe(true);
    expect(window.scrollTo).toHaveBeenCalled();
  });

  it('17, 15c: a click on a passage goes to its card (caretRangeFromPoint), focused and active', () => {
    const c = card('a');
    c.scrollIntoView = vi.fn();
    showHighlights([thread({ id: 'a', quote: 'up to 3' })]);
    const text = root().querySelector('strong')!.firstChild!;
    const hit = document.createRange();
    hit.setStart(text, 2);
    (document as unknown as { caretRangeFromPoint: () => Range }).caretRangeFromPoint = () => hit;
    onPassageClick(new MouseEvent('click', { clientX: 1, clientY: 1 }));
    expect(c.scrollIntoView).toHaveBeenCalled();
    expect(document.activeElement).toBe(c);
    expect(c.hasAttribute('data-active')).toBe(true);
    delete (document as unknown as { caretRangeFromPoint?: unknown }).caretRangeFromPoint;
  });

  it('a click in a text field, or on a link in a passage, does nothing and throws nothing', () => {
    const c = card('a');
    c.scrollIntoView = vi.fn();
    showHighlights([thread({ id: 'a', quote: 'ones waiting' })]);
    const field = document.createElement('textarea');
    field.value = 'typed';
    document.body.append(field);
    const doc = document as unknown as { caretPositionFromPoint?: () => unknown };
    doc.caretPositionFromPoint = () => ({ offsetNode: field, offset: 3 });
    expect(() => onPassageClick(new MouseEvent('click'))).not.toThrow();
    const link = root().querySelector('a[href="/x"]')!;
    doc.caretPositionFromPoint = () => ({ offsetNode: link.firstChild, offset: 2 });
    const onLink = new MouseEvent('click', { bubbles: true });
    Object.defineProperty(onLink, 'target', { value: link });
    onPassageClick(onLink);
    expect(c.scrollIntoView).not.toHaveBeenCalled();
    delete doc.caretPositionFromPoint;
  });

  it('16: after the content redraws, "Show in page" follows the new passage, and goes when it is gone', () => {
    const c = card('a');
    window.scrollTo = vi.fn();
    showHighlights([thread({ id: 'a', quote: 'up to 3' })]);
    // The content replaced, as a content update does.
    root().innerHTML = root().innerHTML;
    showHighlights([thread({ id: 'a', quote: 'up to 3' })]);
    (c.querySelector('.rv-show') as HTMLButtonElement).click();
    const [range] = registry.get(ACTIVE)!.ranges;
    expect(root().contains(range.startContainer)).toBe(true);
    root().querySelector('strong')!.textContent = 'many';
    showHighlights([thread({ id: 'a', quote: 'up to 3' })]);
    expect(c.querySelector('.rv-show')).toBeNull();
  });

  it('15b: without a caret API a click does nothing', () => {
    const c = card('a');
    c.scrollIntoView = vi.fn();
    showHighlights([thread({ id: 'a', quote: 'up to 3' })]);
    expect(() => onPassageClick(new MouseEvent('click'))).not.toThrow();
    expect(c.scrollIntoView).not.toHaveBeenCalled();
  });

  it('18: clearing (a page change) removes every mark', () => {
    showHighlights([thread({ quote: 'up to 3' })]);
    clearHighlights();
    expect(registry.has(HIGHLIGHT)).toBe(false);
    expect(registry.has(ACTIVE)).toBe(false);
  });
});
