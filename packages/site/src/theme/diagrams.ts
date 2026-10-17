// Mermaid diagrams (#102), drawn in the reader's browser. A `mermaid` code
// block is built and sanitized like any other code block, so its source stays
// in the section text the hub checks quotes against; here, after the page is
// in the DOM, each block gets a drawn diagram before it and is hidden. Pages
// without one load nothing: Mermaid is imported only when a block is found,
// from the copy the build puts in the site (build/mermaid.ts).
import type { Mermaid, MermaidConfig } from 'mermaid';
import { onContentUpdated, useData } from 'vitepress';
import { defineComponent, onMounted, onUnmounted } from 'vue';
import './diagrams.css';

export const DIAGRAM_CLASS = 'sr-diagram';
export const SOURCE_CLASS = 'sr-diagram-source';
export const ERROR_CLASS = 'sr-diagram-error';
export const ZOOM_BUTTON_CLASS = 'sr-diagram-zoom';
export const ZOOM_CLASS = 'sr-zoom';
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
      addZoom(figure);
      block.before(figure);
      block.classList.add(SOURCE_CLASS);
      block.dataset.srDiagram = 'drawn';
    } catch (error) {
      block.dataset.srDiagram = 'failed';
      if (block.isConnected) block.after(errorLine(error));
    }
  }
};

// Click to see a diagram full size (#105). A real button beside the diagram
// opens it for the keyboard and screen readers (the SVG keeps its own role
// and title); a click on the diagram does the same with a mouse. The SVG is
// moved into a modal dialog and back, never copied, so its ids, arrow
// markers and scoped styles stay unique. The dialog sits outside the page
// content, so the review panel never offers to comment on it.
type Zoomed = {
  dialog: HTMLDialogElement;
  figure: HTMLElement;
  svg: SVGSVGElement;
  opener: HTMLElement;
  attrs: [string, string | null][];
};
let zoomed: Zoomed | null = null;
const SIZE_ATTRS = ['width', 'height', 'style'];

// The diagram's own title, when its author gave one (Mermaid's accTitle).
const titleOf = (svg: SVGSVGElement) => {
  const id = svg.getAttribute('aria-labelledby');
  return ((id && svg.querySelector(`[id="${CSS.escape(id)}"]`)?.textContent) || '').trim().slice(0, 100);
};

// Closing from the dialog returns focus to the button that opened it. A
// navigation closes it without moving focus: the reader is on another page.
export const closeZoom = (restoreFocus = true) => {
  const z = zoomed;
  if (!z) return;
  zoomed = null;
  for (const [name, value] of z.attrs) {
    if (value === null) z.svg.removeAttribute(name);
    else z.svg.setAttribute(name, value);
  }
  if (z.figure.isConnected) z.figure.append(z.svg);
  if (z.dialog.open) z.dialog.close();
  z.dialog.remove();
  if (restoreFocus) z.opener.focus();
};

export const openZoom = (figure: HTMLElement, opener: HTMLElement) => {
  const svg = figure.querySelector('svg');
  if (zoomed || !svg) return;
  const dialog = document.createElement('dialog');
  dialog.className = ZOOM_CLASS;
  const title = titleOf(svg);
  dialog.setAttribute('aria-label', title ? `Diagram: ${title}` : 'Diagram');
  const close = document.createElement('button');
  close.type = 'button';
  close.className = `${ZOOM_CLASS}-close`;
  close.textContent = 'Close';
  const bar = document.createElement('div');
  bar.className = `${ZOOM_CLASS}-bar`;
  bar.append(close);
  const body = document.createElement('div');
  body.className = `${ZOOM_CLASS}-body`;
  const attrs = SIZE_ATTRS.map((name): [string, string | null] => [name, svg.getAttribute(name)]);
  // At its own size: Mermaid sets width 100% and a max-width to fit the
  // column. Without a viewBox there is no own size, so it is left as drawn.
  const width = svg.viewBox?.baseVal?.width;
  if (width) {
    svg.removeAttribute('style');
    svg.removeAttribute('height');
    svg.setAttribute('width', String(Math.ceil(width)));
  }
  body.append(svg);
  dialog.append(bar, body);
  document.body.append(dialog);
  zoomed = { dialog, figure, svg, opener, attrs };
  close.addEventListener('click', () => closeZoom());
  // However the dialog closes (Esc, or any close request the browser makes),
  // the SVG goes back and the next diagram can open.
  // The event comes a task later: it closes only its own dialog.
  dialog.addEventListener('close', () => {
    if (zoomed?.dialog === dialog) closeZoom();
  });
  // A click on the backdrop lands on the dialog itself; its content is in
  // body. Pressed there too, so a drag-select that ends outside stays open.
  let pressedOnBackdrop = false;
  dialog.addEventListener('mousedown', (e) => (pressedOnBackdrop = e.target === dialog));
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog && pressedOnBackdrop) closeZoom();
  });
  dialog.showModal();
  close.focus();
};

const addZoom = (figure: HTMLElement) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = ZOOM_BUTTON_CLASS;
  button.textContent = 'Enlarge';
  const svg = figure.querySelector('svg');
  const title = svg ? titleOf(svg) : '';
  button.setAttribute('aria-label', title ? `Enlarge diagram: ${title}` : 'Enlarge diagram');
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    openZoom(figure, button);
  });
  figure.addEventListener('click', () => openZoom(figure, button));
  // In its own row above the diagram: never over a node, its ring never clipped.
  const row = document.createElement('div');
  row.className = `${ZOOM_BUTTON_CLASS}-row`;
  row.append(button);
  figure.prepend(row);
};

// Copied into the site by the build (build/mermaid.ts MERMAID_DIR), not
// bundled: Vite leaves this import alone.
// The installed Mermaid's version: a test fails if they differ (#104).
export const MERMAID_VERSION = '12.2.0';
export const mermaidUrl = (base: string) => `${base}assets/mermaid-${MERMAID_VERSION}/mermaid.esm.min.mjs`;
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
      // A new page: any dialog belongs to the one that left.
      closeZoom(false);
      const root = document.querySelector('.vp-doc');
      if (root) void drawDiagrams(root, load);
    };
    onContentUpdated(drawPage);
    onMounted(drawPage);
    onUnmounted(() => closeZoom(false));
    return () => null;
  },
});
