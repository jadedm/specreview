// Text rules shared by the build, the Worker and the reader UI, so a quote
// that the browser found in a section is found by the server the same way.

// Collapses every run of whitespace (spaces, tabs, line breaks, non-breaking
// spaces) to one space and trims, because the rendered page and the source
// wrap lines differently.
export const normalise = (text: string): string => text.replace(/\s+/gu, ' ').trim();

export const quoteIn = (quote: string, sectionText: string): boolean => {
  const q = normalise(quote);
  return q.length > 0 && normalise(sectionText).includes(q);
};

export const STATUSES = ['pending', 'in_review', 'ready'] as const;
export type Status = (typeof STATUSES)[number];

export const STATUS_LABEL: Record<Status, string> = {
  pending: 'docs: pending',
  in_review: 'docs: in review',
  ready: 'docs: ready to build',
};

export type Section = { id: string; title: string; text: string };
export type HistoryEntry = {
  commit: string;
  date: string;
  author: string;
  pr: number | null;
  path: string;
  // Content hash of the page at this commit; a comment stores the hash it was made on.
  hash: string;
};
export type ManifestPage = {
  title: string;
  hash: string;
  issues: number[];
  sections: Section[];
  history: HistoryEntry[];
};
// csp: the Content-Security-Policy for every response of this version; absent
// means default-src 'self'.
// A prototype file published untouched (#111): its path in the docs folder
// and the sha256 of its bytes, so the hub can check the bundle's proto/ part.
export type PrototypeFile = { path: string; hash: string };
export type Manifest = {
  commit: string;
  builtAt: string;
  csp?: string;
  pages: Record<string, ManifestPage>;
  prototypes?: PrototypeFile[];
};

// A path left out of a site (#88), relative to the docs folder: letters,
// digits and . _ ~ - / *, no leading / or - (it would read as an option), no . or .. segment, ** only as a
// whole segment. Matching is case-sensitive.
const EXCLUDE_SHAPE = /^(?![/-])(?!.*\/\/)(?!.*(^|\/)\.{1,2}(\/|$))[A-Za-z0-9._~*/-]+$/;
export const isExcludePattern = (p: string, max = 200): boolean =>
  p.length <= max && EXCLUDE_SHAPE.test(p) && p.split('/').every((seg) => !seg.includes('**') || seg === '**');
