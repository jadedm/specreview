import type { Manifest, ManifestPage } from '../shared/text';
import { AppError } from './http';
import type { SiteStore } from './store';

// Cached per site for the isolate's life; a failed load is not cached, and
// one site's missing or broken manifest never touches another's entry.
const cache = new Map<string, Promise<Manifest>>();

const isManifest = (m: unknown): m is Manifest =>
  typeof m === 'object' && m !== null && typeof (m as Manifest).pages === 'object' && (m as Manifest).pages !== null;

export const manifestOf = (store: SiteStore, site: string): Promise<Manifest> => {
  const existing = cache.get(site);
  if (existing) return existing;
  const loading = store.manifest(site).then((m) => {
    if (!isManifest(m)) throw new AppError(503, 'SITE_NOT_PUBLISHED', 'This site has not been published yet.');
    return m;
  });
  cache.set(site, loading);
  loading.catch(() => cache.delete(site));
  return loading;
};

// For tests: a new manifest must be read after a publish.
export const forgetManifests = () => cache.clear();

export const pageOf = async (store: SiteStore, site: string, page: string): Promise<ManifestPage> => {
  const manifest = await manifestOf(store, site);
  const found = Object.hasOwn(manifest.pages, page) ? manifest.pages[page] : undefined;
  if (!found) throw new AppError(400, 'UNKNOWN_PAGE');
  return found;
};
