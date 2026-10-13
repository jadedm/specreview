// #43, #45: the hub's bare address shows a signed-in visitor an index of the
// sites they may read. Case numbers are the tickets'.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TITLE_WAIT_MS } from '../src/root';
import { memoryStore, type SiteStore } from '../src/store';
import { call, CONFIG, deps, installFetch, publishedFiles, reset, SIDECAR, VERSION } from './helpers';

let spy: ReturnType<typeof installFetch>;
beforeEach(async () => {
  spy = installFetch();
  await reset();
});
afterEach(() => spy.mockRestore());

const root = (email?: string, opts: Record<string, unknown> = {}) => call('/', { raw: true, email, ...opts });
// The page without its style block, for checks on what it says.
const text = (r: { body: unknown }) => String(r.body).replace(/<style>[^<]*<\/style>/, '');
const withConfig = (cfg: unknown) => ({ envOverride: { SPECREVIEW_CONFIG: JSON.stringify(cfg) } });
const sha256 = async (text: string) =>
  btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))));

describe('43: the hub root', () => {
  it('1, #45: one readable site is listed on the index, not redirected to', async () => {
    const r = await root('pm@globex.dev');
    expect([r.status, r.headers.get('location')]).toEqual([200, null]);
    expect([...String(r.body).matchAll(/href="([^"]+)"/g)].map((m) => m[1])).toEqual(['/globex/']);
  });

  it('2: several readable sites are a list of exactly those, in config order', async () => {
    const team = await root('dev@acme.dev');
    expect(team.status).toBe(200);
    expect([...String(team.body).matchAll(/href="([^"]+)"/g)].map((m) => m[1])).toEqual(['/sidecar/', '/web/']);
    expect(String(team.body)).not.toContain('globex');
    const reader = await root('riya@initech.example');
    expect([...String(reader.body).matchAll(/href="([^"]+)"/g)].map((m) => m[1])).toEqual([
      '/sidecar/',
      '/web/',
      '/globex/',
    ]);
  });

  it('3, #45: a reader of one site among three sees only that site named', async () => {
    const cfg = structuredClone(CONFIG);
    cfg.sites[1].readers = [];
    cfg.sites[2].readers = [];
    const r = await root('riya@initech.example', withConfig(cfg));
    expect(r.status).toBe(200);
    expect([...String(r.body).matchAll(/href="([^"]+)"/g)].map((m) => m[1])).toEqual(['/sidecar/']);
    for (const other of ['web', 'globex']) expect(text(r)).not.toContain(other);
  });

  it('4: signed in with no readable site is a 403 page naming no site', async () => {
    const r = await root('x@stranger.example');
    expect(r.status).toBe(403);
    expect(r.headers.get('content-type')).toContain('text/html');
    for (const repo of ['sidecar', 'web', 'globex']) expect(text(r)).not.toContain(repo);
  });

  it('5: no token or a bad one is 401', async () => {
    expect((await root()).status).toBe(401);
    expect((await root(undefined, { token: 'not-a-jwt' })).status).toBe(401);
  });

  it('6: other methods on / stay 404', async () => {
    expect((await call('/', { raw: true, email: 'dev@acme.dev', method: 'POST', body: {} })).status).toBe(404);
    // Refused before identity: no token is still 404, not 401.
    expect((await call('/', { raw: true, method: 'POST', body: {} })).status).toBe(404);
  });

  it('7: the brand name is escaped in the top bar', async () => {
    const r = await root('dev@acme.dev', withConfig({ ...CONFIG, brand: { name: '<b>Acme & "co"</b>' } }));
    expect(String(r.body)).toContain('<span class="org">&lt;b&gt;Acme &amp; &quot;co&quot;&lt;/b&gt;</span>');
    expect(String(r.body)).not.toContain('<b>');
    const plain = await root('dev@acme.dev');
    expect(String(plain.body)).toContain('<span class="org">acme</span>');
  });

  it('8: the pages are never cached or framed and allow only their own style', async () => {
    for (const email of ['dev@acme.dev', 'x@stranger.example']) {
      const r = await root(email);
      const style = /<style>([^<]*)<\/style>/.exec(String(r.body))?.[1] ?? '';
      expect(r.headers.get('cache-control')).toBe('private, no-store');
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
      expect(r.headers.get('x-frame-options')).toBe('DENY');
      expect(r.headers.get('content-security-policy')).toBe(
        `default-src 'none'; style-src 'sha256-${await sha256(style)}'`,
      );
    }
  });

  it('review, #45: HEAD answers each case with no body, never cached', async () => {
    const head = (email: string) => call('/', { raw: true, email, method: 'HEAD' });
    const one = await head('pm@globex.dev');
    expect([one.status, one.headers.get('cache-control'), String(one.body)]).toEqual([200, 'private, no-store', '']);
    expect(one.headers.get('location')).toBeNull();
    const many = await head('dev@acme.dev');
    expect([many.status, String(many.body)]).toEqual([200, '']);
    const none = await head('x@stranger.example');
    expect([none.status, String(none.body)]).toEqual([403, '']);
  });

  it('10: an invalid config still refuses /', async () => {
    const r = await root('dev@acme.dev', { envOverride: { SPECREVIEW_CONFIG: '{}' } });
    expect(r.status).toBe(500);
  });
});

describe('48: the index in the house style', () => {
  const rows = (r: { body: unknown }) =>
    [...String(r.body).matchAll(/<span class="title">([^<]*)<\/span><span class="path">([^<]*)<\/span>/g)].map((m) => [
      m[1],
      m[2],
    ]);

  it('1, 2: each site shows its published title, or its repo name when it has none', async () => {
    const r = await root('dev@acme.dev');
    expect(r.status).toBe(200);
    expect(rows(r)).toEqual([
      ['sidecar docs', '/sidecar/'],
      ['web', '/web/'],
    ]);
  });

  it('2: an unpublished site falls back to its repo name, page still 200', async () => {
    // sidecar has a titled index while published, so the fallback shows.
    const files = publishedFiles();
    files.delete(`${SIDECAR}/current.json`);
    deps.store = memoryStore(files);
    const r = await root('dev@acme.dev');
    expect(r.status).toBe(200);
    expect(rows(r)[0]).toEqual(['sidecar', '/sidecar/']);
  });

  it('2: a broken pointer falls back to the repo name, page still 200', async () => {
    const files = publishedFiles();
    files.set(`${SIDECAR}/current.json`, 'not json');
    deps.store = memoryStore(files);
    const r = await root('dev@acme.dev');
    expect(r.status).toBe(200);
    expect(rows(r)[0]).toEqual(['sidecar', '/sidecar/']);
  });

  it('review: a store that does not answer cannot stall the page past the wait', async () => {
    deps.store = { get: () => new Promise(() => {}) };
    const started = Date.now();
    const r = await root('dev@acme.dev');
    expect(r.status).toBe(200);
    expect(rows(r).map(([title]) => title)).toEqual(['sidecar', 'web']);
    expect(Date.now() - started).toBeLessThan(TITLE_WAIT_MS + 1_500);
  });

  it('3: the store down: repo names, page still 200, nothing about the store', async () => {
    deps.store = { get: () => Promise.reject(new Error('bucket specreview-sites failed')) };
    const r = await root('dev@acme.dev');
    expect(r.status).toBe(200);
    expect(rows(r).map(([title]) => title)).toEqual(['sidecar', 'web']);
    expect(text(r)).not.toMatch(/specreview-sites|bucket/);
  });

  it('4: the no-access page reads nothing from the store', async () => {
    const reads: string[] = [];
    const inner = memoryStore(publishedFiles());
    deps.store = { get: async (k) => (reads.push(k), inner.get(k)) } satisfies SiteStore;
    const r = await root('x@stranger.example');
    expect(r.status).toBe(403);
    expect(reads).toEqual([]);
    expect(String(r.body)).toContain('<span class="org">acme</span>');
  });

  it('7: every colour in the page is a true grey (house style, #32)', async () => {
    const style = /<style>([^<]*)<\/style>/.exec(String((await root('dev@acme.dev')).body))?.[1] ?? '';
    const hexes = style.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(hexes.length).toBeGreaterThan(0);
    for (const hex of hexes) {
      const h = hex.slice(1);
      const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h.slice(0, 6);
      expect([full.slice(0, 2), full.slice(2, 4)], hex).toEqual([full.slice(2, 4), full.slice(4, 6)]);
    }
    expect(style).not.toMatch(/rgb|hsl|oklch|lab\(/);
  });

  it('5: a title with markup characters is escaped', async () => {
    const files = publishedFiles();
    const key = `${SIDECAR}/v/${VERSION}/manifest.json`;
    const manifest = JSON.parse(files.get(key)!) as { pages: Record<string, { title: string }> };
    manifest.pages.index.title = '<img src=x onerror=alert(1)> & co';
    files.set(key, JSON.stringify(manifest));
    deps.store = memoryStore(files);
    const r = await root('dev@acme.dev');
    expect(String(r.body)).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; co');
    expect(text(r)).not.toContain('<img');
  });
});
