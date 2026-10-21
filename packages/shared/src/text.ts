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

// A thread's context (#38): up to this many characters of the section's text
// either side of the quote, so a quote that appears more than once can be
// told apart, and found again after its heading is renamed.
export const CONTEXT = 32;

// Where a quote with its context sits in a text: the start of each occurrence
// (in the normalised text) whose text before ends with the prefix and text
// after starts with the suffix. An empty side matches anything. Whitespace is
// collapsed, never removed, so "foo bar" is not found in "foobar".
export const placesIn = (quote: string, prefix: string, suffix: string, text: string): number[] => {
  const q = normalise(quote);
  if (q.length === 0) return [];
  const t = normalise(text);
  const p = normalise(prefix);
  const s = normalise(suffix);
  const found: number[] = [];
  // Only the few characters either side are compared: at most one space sits
  // between, since the text is collapsed.
  for (let at = t.indexOf(q); at >= 0; at = t.indexOf(q, at + 1)) {
    const before = t.slice(Math.max(0, at - p.length - 1), at).trimEnd();
    const end = at + q.length;
    const after = t.slice(end, end + s.length + 1).trimStart();
    if (before.endsWith(p) && after.startsWith(s)) found.push(at);
  }
  return found;
};

// The context of a quote at [start, end) in a normalised text.
export const contextAt = (text: string, start: number, end: number) => ({
  prefix: text.slice(0, start).trimEnd().slice(-CONTEXT).trimStart(),
  suffix: text.slice(end).trimStart().slice(0, CONTEXT).trimEnd(),
});

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
export type IssueLink = number | string;
export type ManifestPage = {
  title: string;
  hash: string;
  // A ticket number in the site's default ticket repo, or `<repo>#<number>`
  // for another repo the site lists (#90).
  issues: IssueLink[];
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
