// Mermaid diagrams (#102), drawn in the reader's browser. A `mermaid` code
// block is built and sanitized like any other code block, so its source stays
// in the section text the hub checks quotes against; here, after the page is
// in the DOM, each block gets a drawn diagram before it and is hidden. Pages
// without one load nothing: Mermaid is imported only when a block is found,
// from the copy the build puts in the site (build/mermaid.ts).
import type { Mermaid, MermaidConfig } from 'mermaid';
import { onContentUpdated, useData } from 'vitepress';
import { defineComponent, onMounted } from 'vue';
import './diagrams.css';

export const DIAGRAM_CLASS = 'sr-diagram';
export const SOURCE_CLASS = 'sr-diagram-source';
export const ERROR_CLASS = 'sr-diagram-error';
const MAX_ERROR = 200;

// Mermaid's own secure keys plus everything that sets colours, fonts, CSS or
// how labels and their sanitizing work: a diagram's %%{init}%% or front
// matter can change none of them (GHSA-87f9-hvmw-gh4p was CSS injected that way).
export const SECURE_KEYS = [
  'secure',
  'securityLevel',
  'startOnLoad',
  'maxTextSize',
  'suppressErrorRendering',
  'maxEdges',
  'theme',
  'themeVariables',
  'themeCSS',
  'look',
  'darkMode',
  'htmlLabels',
  'fontFamily',
  'altFontFamily',
  'fontSize',
  'dompurifyConfig',
  'arrowMarkerAbsolute',
  'legacyMathML',
  'forceLegacyMathML',
];

// Greys only, as the house theme (house.css, #32).
const GREY = { line: '#555555', text: '#1f1f1f', fill: '#f2f2f2', edge: '#e6e6e6', bg: '#ffffff' };

export const DIAGRAM_CONFIG: MermaidConfig = {
  startOnLoad: false,
  securityLevel: 'strict',
  suppressErrorRendering: true,
  htmlLabels: false,
  theme: 'base',
  darkMode: false,
  // house.css's --vp-font-family-base: the system font, nothing fetched.
  fontFamily: "system-ui, -apple-system, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
  themeVariables: {
    background: GREY.bg,
    primaryColor: GREY.fill,
    primaryTextColor: GREY.text,
    primaryBorderColor: GREY.line,
    secondaryColor: GREY.edge,
    tertiaryColor: GREY.bg,
    lineColor: GREY.line,
    textColor: GREY.text,
    mainBkg: GREY.fill,
    clusterBkg: GREY.bg,
    clusterBorder: GREY.line,
    edgeLabelBackground: GREY.bg,
  },
  secure: SECURE_KEYS,
};

// The blocks still to draw: VitePress wraps a fence in div.language-<lang>.
export const pendingBlocks = (root: ParentNode): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>('div.language-mermaid')].filter((b) => !b.dataset.srDiagram);

const errorLine = (error: unknown) => {
  const p = document.createElement('p');
  p.className = ERROR_CLASS;
  const message = String(error instanceof Error ? error.message : error)
    .replace(/\s+/g, ' ')
    .trim();
  p.textContent = `This diagram could not be drawn: ${message.slice(0, MAX_ERROR)}`;
  return p;
};

let seq = 0;

// Draws every pending block under root. A block is marked before the first
// await, so a second call while one is running never draws it twice.
export const drawDiagrams = async (root: ParentNode, load: () => Promise<Mermaid>) => {
  const blocks = pendingBlocks(root);
  if (blocks.length === 0) return;
  for (const b of blocks) b.dataset.srDiagram = 'pending';
  let mermaid: Mermaid;
  try {
    mermaid = await load();
    mermaid.initialize(DIAGRAM_CONFIG);
  } catch (error) {
    for (const b of blocks) {
      b.dataset.srDiagram = 'failed';
      b.after(errorLine(error));
    }
    return;
  }
  for (const block of blocks) {
    const source = block.querySelector('code')?.textContent ?? '';
    try {
      const { svg } = await mermaid.render(`sr-diagram-${++seq}`, source);
      if (!block.isConnected) continue;
      const figure = document.createElement('div');
      figure.className = DIAGRAM_CLASS;
      // Mermaid's strict mode has passed its output through DOMPurify. No role
      // here: the SVG carries Mermaid's own role and accessible title.
      figure.innerHTML = svg;
      block.before(figure);
      block.classList.add(SOURCE_CLASS);
      block.dataset.srDiagram = 'drawn';
    } catch (error) {
      block.dataset.srDiagram = 'failed';
      if (block.isConnected) block.after(errorLine(error));
    }
  }
};

// Copied into the site by the build (build/mermaid.ts MERMAID_DIR), not
// bundled: Vite leaves this import alone.
export const mermaidUrl = (base: string) => `${base}assets/mermaid/mermaid.esm.min.mjs`;
const loaderFor = (base: string) => () =>
  (import(/* @vite-ignore */ mermaidUrl(base)) as Promise<{ default: Mermaid }>).then((m) => m.default);

// Rendered in the layout's doc-after slot. VitePress runs onContentUpdated
// once the page's content is in the DOM, on the first page and every one
// after; the review panel keeps router.onAfterPageLoad, which runs earlier.
export const Diagrams = defineComponent({
  name: 'Diagrams',
  setup() {
    const load = loaderFor(useData().site.value.base);
    const drawPage = () => {
      const root = document.querySelector('.vp-doc');
      if (root) void drawDiagrams(root, load);
    };
    onContentUpdated(drawPage);
    onMounted(drawPage);
    return () => null;
  },
});
