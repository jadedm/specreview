import type { HistoryEntry, Manifest, ManifestPage, Section } from './text.js';

// The manifest a build writes and the hub reads. Both validate it with this
// one function, so a build never publishes a manifest the hub would refuse.
const COMMIT = /^[0-9a-f]{40}$/;
// The status API takes a hash of at most 100 characters with no spaces or
// control characters.
const HASH = /^[\x21-\x7e]{1,100}$/;
// The CSP becomes a header: printable ASCII only, so a stray newline is a
// broken manifest (503) rather than a header error on every page (500).
const CSP = /^[\x20-\x7e]*[\x21-\x7e][\x20-\x7e]*$/;
// The hub reads the whole manifest into memory per isolate and sends every
// page's section text to the UI.
export const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;

const isString = (v: unknown): v is string => typeof v === 'string';
const isSection = (s: unknown): s is Section =>
  typeof s === 'object' &&
  s !== null &&
  isString((s as Section).id) &&
  isString((s as Section).title) &&
  isString((s as Section).text);
const isHistoryEntry = (h: unknown): h is HistoryEntry =>
  typeof h === 'object' &&
  h !== null &&
  COMMIT.test(String((h as HistoryEntry).commit)) &&
  isString((h as HistoryEntry).path) &&
  isString((h as HistoryEntry).hash);
const isPage = (p: unknown): p is ManifestPage => {
  if (typeof p !== 'object' || p === null) return false;
  const page = p as ManifestPage;
  const issuesOk =
    Array.isArray(page.issues) &&
    page.issues.every((n) => Number.isSafeInteger(n) && n > 0) &&
    new Set(page.issues).size === page.issues.length;
  return (
    isString(page.title) &&
    isString(page.hash) &&
    // The status API takes a hash of at most 100 characters with no spaces
    // or control characters.
    HASH.test(page.hash) &&
    issuesOk &&
    Array.isArray(page.sections) &&
    page.sections.every(isSection) &&
    new Set(page.sections.map((s) => s.id)).size === page.sections.length &&
    Array.isArray(page.history) &&
    page.history.every(isHistoryEntry)
  );
};

export const isManifest = (m: unknown): m is Manifest => {
  if (typeof m !== 'object' || m === null || Array.isArray(m)) return false;
  const man = m as Manifest & { csp?: unknown };
  if (!COMMIT.test(String(man.commit)) || !isString(man.builtAt)) return false;
  // The CSP becomes a header: printable ASCII only, so a stray newline is a
  // broken manifest (503) rather than a header error on every page (500).
  if (man.csp !== undefined && (!isString(man.csp) || !CSP.test(man.csp))) return false;
  if (typeof man.pages !== 'object' || man.pages === null || Array.isArray(man.pages)) return false;
  return Object.values(man.pages).every(isPage);
};
