// @vitest-environment happy-dom
import type { Mermaid } from 'mermaid';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MERMAID_DIR, MERMAID_ENTRY } from '../build/mermaid';
import { createApp } from 'vue';
import {
  closeZoom,
  DIAGRAM_CONFIG,
  Diagrams,
  drawDiagrams,
  mermaidUrl,
  openZoom,
  pendingBlocks,
  SECURE_KEYS,
} from './diagrams';
import { sectionOfSelection } from './review/selection';

// onContentUpdated callbacks are kept, so a test can play a page change.
const contentUpdated: (() => void)[] = [];
vi.mock('vitepress', () => ({
  onContentUpdated: (fn: () => void) => contentUpdated.push(fn),
  useData: () => ({ site: { value: { base: '/' } } }),
}));

const block = (lang: string, code: string) =>
  `<div class="language-${lang} vp-adaptive-theme"><pre class="shiki" v-pre><code>${code}</code></pre></div>`;

const page = (html: string) => {
  document.body.innerHTML = `<div class="vp-doc"><div>${html}</div></div>`;
  return document.querySelector<HTMLElement>('.vp-doc')!;
};

// A stand-in for Mermaid: draws a fixed SVG, or throws for source containing "bad".
const fake = () => {
  const render = vi.fn(async (_id: string, text: string) => {
    if (text.includes('bad')) throw new Error('Parse error <img src=x onerror="window.hit=1">');
    return {
      svg: `<svg id="m${text.length}" viewBox="0 0 1800 300" width="100%" style="max-width: 1800px;" role="graphics-document document"><text>drawn</text></svg>`,
    };
  });
  const initialize = vi.fn();
  return { mermaid: { render, initialize } as unknown as Mermaid, render, initialize };
};

beforeEach(() => {
  closeZoom(false);
  document.body.innerHTML = '';
  delete (window as { hit?: number }).hit;
});

describe('pendingBlocks', () => {
  it('finds mermaid blocks only, and not ones already handled', () => {
    const root = page(block('mermaid', 'a') + block('ts', 'b') + block('mermaid-ish', 'c') + block('mermaid', 'd'));
    root.querySelectorAll<HTMLElement>('div.language-mermaid')[1].dataset.srDiagram = 'drawn';
    expect(pendingBlocks(root).map((b) => b.textContent)).toEqual(['a']);
  });
});

describe('drawDiagrams', () => {
  it('loads nothing on a page without a diagram', async () => {
    const load = vi.fn();
    await drawDiagrams(page(block('ts', 'x')), load);
    expect(load).not.toHaveBeenCalled();
  });

  it('draws each diagram before its block and hides the block', async () => {
    const { mermaid, initialize } = fake();
    const root = page('<p>before</p>' + block('mermaid', 'flowchart LR\n A --> B') + '<p>after</p>');
    await drawDiagrams(root, async () => mermaid);
    expect(initialize).toHaveBeenCalledWith(DIAGRAM_CONFIG);
    const fig = root.querySelector('.sr-diagram')!;
    expect(fig.querySelector('svg')).not.toBeNull();
    expect(fig.nextElementSibling?.classList.contains('sr-diagram-source')).toBe(true);
    expect(root.querySelector('div.language-mermaid')!.getAttribute('data-sr-diagram')).toBe('drawn');
  });

  it('keeps a diagram that fails visible, with its error as text', async () => {
    const { mermaid } = fake();
    const root = page(block('mermaid', 'bad') + block('mermaid', 'good'));
    await drawDiagrams(root, async () => mermaid);
    const [bad, good] = root.querySelectorAll<HTMLElement>('div.language-mermaid');
    expect(bad.classList.contains('sr-diagram-source')).toBe(false);
    expect(bad.dataset.srDiagram).toBe('failed');
    const line = bad.nextElementSibling!;
    expect(line.className).toBe('sr-diagram-error');
    expect(line.textContent).toContain('<img src=x');
    expect(line.querySelector('img')).toBeNull();
    expect(good.dataset.srDiagram).toBe('drawn');
  });

  it('says so on every block when Mermaid cannot be loaded', async () => {
    const root = page(block('mermaid', 'a') + block('mermaid', 'b'));
    await drawDiagrams(root, () => Promise.reject(new Error('chunk failed')));
    expect([...root.querySelectorAll('.sr-diagram-error')].map((e) => e.textContent)).toEqual([
      'This diagram could not be drawn: chunk failed',
      'This diagram could not be drawn: chunk failed',
    ]);
  });

  it('cuts a long error to 200 characters', async () => {
    const root = page(block('mermaid', 'a'));
    await drawDiagrams(root, () => Promise.reject(new Error('x'.repeat(500))));
    expect(root.querySelector('.sr-diagram-error')!.textContent).toBe(
      `This diagram could not be drawn: ${'x'.repeat(200)}`,
    );
  });

  it('never draws a block twice when called again while drawing', async () => {
    const { mermaid, render } = fake();
    const root = page(block('mermaid', 'a'));
    await Promise.all([drawDiagrams(root, async () => mermaid), drawDiagrams(root, async () => mermaid)]);
    expect(render).toHaveBeenCalledTimes(1);
    expect(root.querySelectorAll('.sr-diagram')).toHaveLength(1);
  });
});

describe('wiring', () => {
  it('loads Mermaid from where the build copies it', () => {
    expect(mermaidUrl('/docs/')).toBe(`/docs/${MERMAID_DIR}/${MERMAID_ENTRY}`);
  });

  it('the layout renders the diagrams component', () => {
    const theme = readFileSync(path.join(import.meta.dirname, 'index.ts'), 'utf8');
    expect(theme).toMatch(/'doc-after': \(\) => \[[^\]]*h\(Diagrams\)/);
  });
});

describe('the stylesheet', () => {
  // Rules the drawing depends on; happy-dom does not load diagrams.css.
  const css = readFileSync(path.join(import.meta.dirname, 'diagrams.css'), 'utf8').replace(/\s+/g, ' ');
  it("hides a drawn diagram's source and fits the diagram to the column", () => {
    expect(css).toContain('.sr-diagram-source { display: none; }');
    expect(css).toMatch(/\.sr-diagram svg \{[^}]*max-width: 100%/);
  });
});

describe('the config', () => {
  it('is strict and keeps Mermaid’s own secure keys', () => {
    expect(DIAGRAM_CONFIG.securityLevel).toBe('strict');
    expect(DIAGRAM_CONFIG.htmlLabels).toBe(false);
    expect(DIAGRAM_CONFIG.suppressErrorRendering).toBe(true);
    for (const key of ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges'])
      expect(SECURE_KEYS).toContain(key);
  });

  it('locks every setting that changes colours, fonts, CSS or label cleaning', () => {
    for (const key of ['theme', 'themeVariables', 'themeCSS', 'fontFamily', 'htmlLabels', 'dompurifyConfig'])
      expect(SECURE_KEYS).toContain(key);
  });

  it('uses greys only', () => {
    for (const value of Object.values(DIAGRAM_CONFIG.themeVariables as Record<string, string>)) {
      const [r, g, b] = [1, 3, 5].map((i) => value.slice(i, i + 2));
      expect(r === g && g === b, value).toBe(true);
    }
  });
});

describe('selection around a diagram', () => {
  const drawn = () => {
    const root = page(
      '<h2 id="flow">Flow</h2><p id="before">The paragraph before.</p>' +
        '<div class="sr-diagram"><svg><text id="label">Review</text></svg></div>' +
        block('mermaid', 'flowchart LR').replace(
          'class="language-mermaid',
          'class="sr-diagram-source language-mermaid',
        ) +
        '<p id="after">The paragraph after.</p>',
    );
    return root.querySelector<HTMLElement>('.vp-doc > div')!;
  };
  const select = (start: Node, startAt: number, end: Node, endAt: number) => {
    const range = document.createRange();
    range.setStart(start, startAt);
    range.setEnd(end, endAt);
    const s = window.getSelection()!;
    s.removeAllRanges();
    s.addRange(range);
    return s;
  };

  it('allows a selection in a paragraph beside a diagram', () => {
    const root = drawn();
    const p = document.getElementById('before')!.firstChild!;
    expect(sectionOfSelection(root, select(p, 4, p, 13))?.quote).toBe('paragraph');
  });

  it('refuses a selection inside a diagram', () => {
    const root = drawn();
    const t = document.getElementById('label')!.firstChild!;
    expect(sectionOfSelection(root, select(t, 0, t, 6))).toBeNull();
  });

  it('refuses a selection in the error line under a diagram that failed', () => {
    const root = drawn();
    const p = document.createElement('p');
    p.className = 'sr-diagram-error';
    p.textContent = 'This diagram could not be drawn: x';
    document.getElementById('after')!.before(p);
    expect(sectionOfSelection(root, select(p.firstChild!, 0, p.firstChild!, 12))).toBeNull();
  });

  it('refuses a selection that runs across a diagram', () => {
    const root = drawn();
    const a = document.getElementById('before')!.firstChild!;
    const b = document.getElementById('after')!.firstChild!;
    expect(sectionOfSelection(root, select(a, 4, b, 8))).toBeNull();
  });
});

describe('click to see a diagram full size (#105)', () => {
  const drawnPage = async () => {
    const { mermaid } = fake();
    const root = page('<p>before</p>' + block('mermaid', 'good') + block('mermaid', 'bad'));
    await drawDiagrams(root, async () => mermaid);
    const figure = root.querySelector<HTMLElement>('.sr-diagram')!;
    const button = figure.querySelector<HTMLButtonElement>('button.sr-diagram-zoom')!;
    return { root, figure, button };
  };
  const dialogs = () => document.querySelectorAll('dialog.sr-zoom');

  it('gives a drawn diagram an Enlarge button and leaves the SVG its own role; a failed one gets none', async () => {
    const { root, figure, button } = await drawnPage();
    expect(button.getAttribute('aria-label')).toBe('Enlarge diagram');
    expect(button.type).toBe('button');
    expect(figure.getAttribute('role')).toBeNull();
    expect(figure.querySelector('svg')!.getAttribute('role')).toBe('graphics-document document');
    expect(root.querySelectorAll('button.sr-diagram-zoom')).toHaveLength(1);
  });

  it('the button opens one named modal dialog holding the diagram itself, at its own width', async () => {
    const { figure, button } = await drawnPage();
    button.click();
    const dialog = document.querySelector<HTMLDialogElement>('dialog.sr-zoom')!;
    expect(dialog.open).toBe(true);
    expect(dialog.getAttribute('aria-label')).toBe('Diagram');
    expect(figure.querySelector('svg')).toBeNull();
    const svg = dialog.querySelector('svg')!;
    expect(svg.getAttribute('width')).toBe('1800');
    expect(svg.getAttribute('style')).toBeNull();
    expect(document.activeElement).toBe(dialog.querySelector('.sr-zoom-close'));
    expect(document.querySelectorAll('#m4')).toHaveLength(1);
  });

  it('a click on the diagram opens it too; a second open while one is up does nothing', async () => {
    const { figure, button } = await drawnPage();
    figure.querySelector('svg')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(dialogs()).toHaveLength(1);
    button.click();
    openZoom(figure, button);
    expect(dialogs()).toHaveLength(1);
  });

  for (const [how, close] of [
    ['the close button', (d: HTMLDialogElement) => d.querySelector<HTMLButtonElement>('.sr-zoom-close')!.click()],
    // Esc, or any close request: the browser closes the dialog and fires close.
    ['Esc', (d: HTMLDialogElement) => d.close()],
    [
      'a backdrop click',
      (d: HTMLDialogElement) => {
        d.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        d.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      },
    ],
  ] as const) {
    it(`${how} closes it, puts the diagram back as it was and focuses the button`, async () => {
      const { figure, button } = await drawnPage();
      button.click();
      close(document.querySelector<HTMLDialogElement>('dialog.sr-zoom')!);
      expect(dialogs()).toHaveLength(0);
      const svg = figure.querySelector('svg')!;
      expect(svg.getAttribute('width')).toBe('100%');
      expect(svg.getAttribute('style')).toBe('max-width: 1800px;');
      expect(document.activeElement).toBe(button);
    });
  }

  it('a late close event from an earlier dialog leaves a newer one open', async () => {
    const { button } = await drawnPage();
    button.click();
    const first = document.querySelector('dialog.sr-zoom')!;
    closeZoom();
    button.click();
    first.dispatchEvent(new Event('close'));
    expect(dialogs()).toHaveLength(1);
  });

  it('a drag that starts in the diagram and ends on the backdrop leaves it open', async () => {
    const { button } = await drawnPage();
    button.click();
    const dialog = document.querySelector('dialog.sr-zoom')!;
    dialog.querySelector('svg text')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    dialog.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(dialogs()).toHaveLength(1);
  });

  it("names the dialog and the button after the diagram's own title, when it has one", async () => {
    const titled = {
      render: async () => ({
        svg: '<svg viewBox="0 0 10 10" aria-labelledby="t1"><title id="t1">Payout flow</title></svg>',
      }),
      initialize: () => {},
    } as unknown as Mermaid;
    const root = page(block('mermaid', 'x'));
    await drawDiagrams(root, async () => titled);
    const button = root.querySelector<HTMLButtonElement>('.sr-diagram-zoom')!;
    expect(button.getAttribute('aria-label')).toBe('Enlarge diagram: Payout flow');
    button.click();
    expect(document.querySelector('dialog.sr-zoom')!.getAttribute('aria-label')).toBe('Diagram: Payout flow');
  });

  it('an SVG without a viewBox opens as drawn', async () => {
    const plain = {
      render: async () => ({ svg: '<svg width="100%" style="max-width: 300px;"></svg>' }),
      initialize: () => {},
    } as unknown as Mermaid;
    const root = page(block('mermaid', 'x'));
    await drawDiagrams(root, async () => plain);
    root.querySelector<HTMLButtonElement>('.sr-diagram-zoom')!.click();
    const svg = document.querySelector('dialog.sr-zoom svg')!;
    expect([svg.getAttribute('width'), svg.getAttribute('style')]).toEqual(['100%', 'max-width: 300px;']);
  });

  it('the component closes an open dialog on a page change and on unmount, without moving focus', async () => {
    contentUpdated.length = 0;
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(Diagrams);
    app.mount(host);
    const { button } = await drawnPage();
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    button.click();
    elsewhere.focus();
    for (const fn of contentUpdated) fn();
    expect(dialogs()).toHaveLength(0);
    expect(document.activeElement).toBe(elsewhere);
    button.click();
    elsewhere.focus();
    app.unmount();
    expect(dialogs()).toHaveLength(0);
    expect(document.activeElement).toBe(elsewhere);
  });

  it('a click inside the diagram in the dialog leaves it open', async () => {
    const { button } = await drawnPage();
    button.click();
    document.querySelector('dialog.sr-zoom svg text')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(dialogs()).toHaveLength(1);
  });

  it('only one dialog: opening another diagram while one is up does nothing', async () => {
    const { mermaid } = fake();
    const root = page(block('mermaid', 'one') + block('mermaid', 'three'));
    await drawDiagrams(root, async () => mermaid);
    const [a, b] = root.querySelectorAll<HTMLElement>('.sr-diagram');
    openZoom(a, a.querySelector('button')!);
    openZoom(b, b.querySelector('button')!);
    expect(dialogs()).toHaveLength(1);
    expect(b.querySelector('svg')).not.toBeNull();
  });

  it('closing for a content update does not move focus, even with the diagram still on the page', async () => {
    const { button } = await drawnPage();
    button.click();
    const focused = document.createElement('button');
    document.body.append(focused);
    focused.focus();
    closeZoom(false);
    expect(dialogs()).toHaveLength(0);
    expect(document.activeElement).toBe(focused);
  });

  it('after a navigation the dialog goes and focus is not sent to the page that left', async () => {
    const { root, button } = await drawnPage();
    button.click();
    root.remove();
    const focused = document.createElement('button');
    document.body.append(focused);
    focused.focus();
    closeZoom(false);
    expect(dialogs()).toHaveLength(0);
    expect(document.activeElement).toBe(focused);
  });
});
