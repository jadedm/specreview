// @vitest-environment happy-dom
import type { Mermaid } from 'mermaid';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MERMAID_DIR, MERMAID_ENTRY } from '../build/mermaid';
import { DIAGRAM_CONFIG, drawDiagrams, mermaidUrl, pendingBlocks, SECURE_KEYS } from './diagrams';
import { sectionOfSelection } from './review/selection';

vi.mock('vitepress', () => ({ onContentUpdated: () => {}, useData: () => ({ site: { value: { base: '/' } } }) }));

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
    return { svg: `<svg data-src="${text.length}"><text>drawn</text></svg>` };
  });
  const initialize = vi.fn();
  return { mermaid: { render, initialize } as unknown as Mermaid, render, initialize };
};

beforeEach(() => {
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
