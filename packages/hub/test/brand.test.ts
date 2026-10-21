// #33: the organisation's name and logo for each site's header. Case numbers
// are the ticket's.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configOf, problemsIn } from '../src/config';
import { memoryStore, type SiteStore } from '../src/store';
import { call, CONFIG, deps, errorCode, GLOBEX, installFetch, publishedFiles, reset, SIDECAR } from './helpers';

let spy: ReturnType<typeof installFetch>;
beforeEach(async () => {
  spy = installFetch();
  await reset();
});
afterEach(() => spy.mockRestore());

const KEY = `_brand/logo-${'a'.repeat(64)}.png`;
const WEBP_KEY = `_brand/logo-${'b'.repeat(64)}.webp`;
const branded = (brand: unknown) => ({ ...structuredClone(CONFIG), brand });
const env = (brand: unknown) => ({ envOverride: { SPECREVIEW_CONFIG: JSON.stringify(branded(brand)) } });
const TEAM = 'dev@acme.dev';
const READER = 'riya@initech.example';
const STRANGER = 'x@stranger.example';

describe('33: brand in the config', () => {
  it('22: valid brands pass through problemsIn and configOf alike', () => {
    for (const brand of [
      { name: 'Acme' },
      { name: 'Acme', logo: { key: KEY, type: 'image/png' } },
      { name: 'Équipe Acme', logo: { key: WEBP_KEY, type: 'image/webp' } },
    ]) {
      const text = JSON.stringify(branded(brand));
      expect(problemsIn(JSON.parse(text)), JSON.stringify(brand)).toEqual([]);
      expect(configOf(text).brand).toEqual({ name: brand.name, logo: brand.logo ?? null });
    }
    expect(configOf(JSON.stringify(CONFIG)).brand).toBeNull();
  });

  it('3, 15, 22: each broken rule is reported, and configOf refuses the same config', () => {
    const cases: [unknown, string][] = [
      ['Acme', 'brand must be an object'],
      [{}, 'brand.name is required'],
      [{ name: '' }, 'brand.name must be 1 to 40 characters'],
      [{ name: 'x'.repeat(41) }, 'brand.name must be 1 to 40 characters'],
      [{ name: ' Acme' }, 'brand.name must have no control characters or outer spaces'],
      [{ name: 'Acme‮' }, 'brand.name must have no control characters or outer spaces'],
      [{ name: 'Acme', colour: 'red' }, 'unknown key brand.colour'],
      [{ name: 'Acme', logo: 'logo.png' }, 'brand.logo must be an object'],
      [
        { name: 'Acme', logo: { key: '_brand/logo.png', type: 'image/png' } },
        'brand.logo.key must be _brand/logo-<sha256>.png or .webp',
      ],
      [
        { name: 'Acme', logo: { key: `_brand/logo-${'a'.repeat(64)}.svg`, type: 'image/svg+xml' } },
        'brand.logo.key must be _brand/logo-<sha256>.png or .webp',
      ],
      [
        { name: 'Acme', logo: { key: `sidecar/v/x/logo-${'a'.repeat(64)}.png`, type: 'image/png' } },
        'brand.logo.key must be _brand/logo-<sha256>.png or .webp',
      ],
      [{ name: 'Acme', logo: { key: KEY, type: 'image/webp' } }, 'brand.logo.type must be image/png for a .png key'],
      [{ name: 'Acme', logo: { key: KEY, type: 'image/png', size: 1 } }, 'unknown key brand.logo.size'],
    ];
    for (const [brand, problem] of cases) {
      expect(problemsIn(branded(brand)), JSON.stringify(brand)).toEqual([problem]);
      expect(() => configOf(JSON.stringify(branded(brand)))).toThrow();
    }
  });
});

describe('33: the brand routes', () => {
  it('2: no brand configured', async () => {
    const r = await call('/api/brand', { email: TEAM });
    expect([r.status, r.body]).toEqual([200, { name: null, logo: false }]);
    expect((await call('/api/brand/logo', { email: TEAM })).status).toBe(404);
  });

  it('6: team and reader get the same answer, on every site', async () => {
    const brand = { name: 'Acme', logo: { key: KEY, type: 'image/png' } };
    for (const [email, site] of [
      [TEAM, SIDECAR],
      [READER, SIDECAR],
      [READER, GLOBEX],
    ]) {
      const r = await call('/api/brand', { email, site, ...env(brand) });
      expect([r.status, r.body], `${email} ${site}`).toEqual([200, { name: 'Acme', logo: true }]);
    }
  });

  it('7: no sign-in is 401; someone who may not read the site is 404, before any store read', async () => {
    const reads: string[] = [];
    const inner = memoryStore(new Map([[KEY, 'png-bytes']]));
    deps.store = { get: async (k) => (reads.push(k), inner.get(k)) } satisfies SiteStore;
    const brand = { name: 'Acme', logo: { key: KEY, type: 'image/png' } };
    expect((await call('/api/brand', env(brand))).status).toBe(401);
    expect((await call('/api/brand/logo', { email: STRANGER, ...env(brand) })).status).toBe(404);
    expect((await call('/api/brand', { email: STRANGER, ...env(brand) })).status).toBe(404);
    expect(reads).toEqual([]);
  });

  it('8: the logo is served with its stored type and the protected headers', async () => {
    const files = publishedFiles();
    files.set(KEY, 'png-bytes');
    deps.store = memoryStore(files);
    const r = await call('/api/brand/logo', {
      email: READER,
      ...env({ name: 'Acme', logo: { key: KEY, type: 'image/png' } }),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/png');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('content-security-policy')).toBe("default-src 'none'");
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect(String(r.body)).toBe('png-bytes');
  });

  it('9: a configured logo missing from the store is 404', async () => {
    const r = await call('/api/brand/logo', {
      email: TEAM,
      ...env({ name: 'Acme', logo: { key: KEY, type: 'image/png' } }),
    });
    expect([r.status, errorCode(r)]).toEqual([404, 'NOT_FOUND']);
  });

  it('10: a store failure is the generic 503', async () => {
    deps.store = { get: () => Promise.reject(new Error('bucket specreview-sites failed')) };
    const r = await call('/api/brand/logo', {
      email: TEAM,
      ...env({ name: 'Acme', logo: { key: KEY, type: 'image/png' } }),
    });
    expect([r.status, errorCode(r)]).toEqual([503, 'STORAGE_UNAVAILABLE']);
    expect(JSON.stringify(r.body)).not.toMatch(/specreview-sites|_brand/);
  });
});
