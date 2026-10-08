import { AppError } from './http';

// Where each site's published files live. Keys, all under the bare repo name:
//   <repo>/current.json                 which version is live (written last)
//   <repo>/v/<version>/<path>           the built site of one publish
//   <repo>/history/<commit>/<path>.md   old page versions
// R2's get() has this shape, so an R2 bucket is a store as it is.
export type StoredObject = { text(): Promise<string>; body: ReadableStream | null };
export type SiteStore = { get(key: string): Promise<StoredObject | null> };

// Any storage failure becomes one generic 503: no key, bucket or error text
// reaches the response.
export const read = async (store: SiteStore, key: string): Promise<StoredObject | null> => {
  try {
    return await store.get(key);
  } catch (err) {
    // The hub's own refusal (no bucket bound) is not a storage outage.
    if (err instanceof AppError) throw err;
    console.error('store read failed', err instanceof Error ? err.message : String(err));
    throw new AppError(503, 'STORAGE_UNAVAILABLE', 'Storage is unavailable; try again shortly.');
  }
};

export const readText = async (store: SiteStore, key: string): Promise<string | null> => {
  const obj = await read(store, key);
  if (!obj) return null;
  try {
    return await obj.text();
  } catch (err) {
    console.error('store read failed', err instanceof Error ? err.message : String(err));
    throw new AppError(503, 'STORAGE_UNAVAILABLE', 'Storage is unavailable; try again shortly.');
  }
};

// For tests: an in-memory store over a map of keys to text.
export const memoryStore = (files: Map<string, string>): SiteStore => ({
  get: async (key) => {
    if (!files.has(key)) return null;
    const text = files.get(key) as string;
    return { text: async () => text, body: new Response(text).body };
  },
});

// A Worker deployed without the SITES bucket bound.
export const unconfiguredStore: SiteStore = {
  get: () => Promise.reject(new AppError(500, 'STORE_NOT_CONFIGURED')),
};
