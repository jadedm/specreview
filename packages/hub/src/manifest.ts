import { isManifest, type Manifest, type ManifestPage } from '@specreview/shared';
import { AppError } from './http';
import { readText, type SiteStore } from './store';

// A publish writes <repo>/v/<version>/... and then <repo>/current.json, so a
// request that reads the pointer once and uses that version for everything
// (manifest, CSP, page body) never mixes two publishes. Versions are write-once:
// <40-hex commit>-<run id>, and since #5 -<run attempt>-<8 random hex>.
export const VERSION = /^[0-9a-f]{40}-[0-9]{1,20}(?:-[0-9]{1,6}-[0-9a-f]{8})?$/;
export const POINTER_TTL_MS = 10_000;

export type Snapshot = { repo: string; version: string; manifest: Manifest };

const notPublished = () => new AppError(503, 'SITE_NOT_PUBLISHED', 'This site has not been published yet.');
const broken = () => new AppError(503, 'SITE_BROKEN', 'This site cannot be shown right now.');

const isString = (v: unknown): v is string => typeof v === 'string';

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

const versionIn = (text: string): string => {
  const p = parseJson(text) as { version?: unknown; publishedAt?: unknown } | undefined;
  const ok = typeof p === 'object' && p !== null && !Array.isArray(p) && isString(p.version) && isString(p.publishedAt);
  if (!ok || !VERSION.test(p.version as string)) throw broken();
  return p.version as string;
};

// Clock for the pointer cache; tests move it.
let clock = () => Date.now();
export const setClockForTests = (fn: () => number) => {
  clock = fn;
};

const pointers = new Map<string, { at: number; version: Promise<string> }>();
const manifests = new Map<string, Promise<Manifest>>();

// Single-flight per repo for POINTER_TTL_MS; a failed or missing read is not
// kept, so the next request tries again.
const currentVersion = (store: SiteStore, repo: string): Promise<string> => {
  const now = clock();
  const hit = pointers.get(repo);
  if (hit && now - hit.at < POINTER_TTL_MS) return hit.version;
  const version = readText(store, `${repo}/current.json`).then((text) => {
    if (text === null) throw notPublished();
    return versionIn(text);
  });
  pointers.set(repo, { at: now, version });
  version.catch(() => {
    if (pointers.get(repo)?.version === version) pointers.delete(repo);
  });
  return version;
};

// Keyed by repo and version: two repos may publish the same version string.
const manifestAt = (store: SiteStore, repo: string, version: string): Promise<Manifest> => {
  const key = `${repo}@${version}`;
  const hit = manifests.get(key);
  if (hit) return hit;
  const loading = readText(store, `${repo}/v/${version}/manifest.json`).then((text) => {
    const parsed = text === null ? undefined : parseJson(text);
    if (!isManifest(parsed)) throw broken();
    return parsed;
  });
  manifests.set(key, loading);
  loading.catch(() => manifests.delete(key));
  return loading;
};

export const snapshotOf = async (store: SiteStore, repo: string): Promise<Snapshot> => {
  const version = await currentVersion(store, repo);
  return { repo, version, manifest: await manifestAt(store, repo, version) };
};

// For tests.
export const forgetManifests = () => {
  pointers.clear();
  manifests.clear();
};

export const pageOf = (snapshot: Snapshot, page: string): ManifestPage => {
  const found = Object.hasOwn(snapshot.manifest.pages, page) ? snapshot.manifest.pages[page] : undefined;
  if (!found) throw new AppError(400, 'UNKNOWN_PAGE');
  return found;
};

// What the review UI needs about every page of the snapshot. History (authors,
// PRs, dates) is the team's. Built fresh: the cached manifest is never changed.
export const pagesView = (snapshot: Snapshot, team: boolean) => ({
  commit: snapshot.manifest.commit,
  pages: Object.fromEntries(
    Object.entries(snapshot.manifest.pages).map(([page, p]) => [
      page,
      {
        title: p.title,
        hash: p.hash,
        issues: p.issues,
        sections: p.sections.map(({ id, title, text }) => ({ id, title, text })),
        ...(team ? { history: p.history } : {}),
      },
    ]),
  ),
});

export const cspOf = (snapshot: Snapshot) => snapshot.manifest.csp ?? "default-src 'self'";
