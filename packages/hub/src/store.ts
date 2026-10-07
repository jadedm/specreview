import type { Manifest } from '../shared/text';
import { AppError } from './http';

// Where a site's built pages, manifest and old versions live. #4 implements
// this on R2; tests use the in-memory store below. Paths reaching history()
// are already validated (routes.ts): a 40-hex commit and plain segments.
export type SiteStore = {
  manifest(site: string): Promise<Manifest | null>;
  history(site: string, commit: string, path: string): Promise<string | null>;
};

export const memoryStore = (manifests: Record<string, Manifest>, history: Record<string, string> = {}): SiteStore => ({
  manifest: async (site) => (Object.hasOwn(manifests, site) ? manifests[site] : null),
  history: async (site, commit, path) => {
    const key = `${site}/${commit}/${path}`;
    return Object.hasOwn(history, key) ? history[key] : null;
  },
});

// Until #4 there is no production store: refuse plainly rather than pretend.
export const unconfiguredStore: SiteStore = {
  manifest: () => Promise.reject(new AppError(500, 'STORE_NOT_CONFIGURED')),
  history: () => Promise.reject(new AppError(500, 'STORE_NOT_CONFIGURED')),
};
