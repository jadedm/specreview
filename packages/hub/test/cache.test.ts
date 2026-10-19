// #104: a published version's content-addressed assets may stay in the
// reader's browser; nothing else may. Case numbers are the ticket's.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isContentAddressed } from '@specreview/shared';
import { memoryStore } from '../src/store';
import { call, CONFIG, deps, installFetch, PAGE, publishedFiles, reset, SIDECAR, VERSION } from './helpers';

// Written out, not imported: the test pins the header itself.
const CACHE_FOREVER = 'private, max-age=31536000, immutable';

let spy: ReturnType<typeof installFetch>;
let files: Map<string, string>;
const HASHED = ['assets/chunks/theme.BwncOpC7.js', 'assets/style.DviUTnfc.css', 'assets/app.Gl_kie-u.js'];
// Page chunks hold the page's text: never kept.
const PAGE_CHUNKS = [
  'assets/guide.md.Gl_kie-u.js',
  'assets/guide.md.Gl_kie-u.lean.js',
  'assets/product_execution-doc.md.CISwuW1_.js',
];
const MERMAID = 'assets/mermaid-12.2.0/mermaid.esm.min.mjs';
const MERMAID_CHUNK = 'assets/mermaid-12.2.0/chunks/mermaid.esm.min/chunk-674HQBI4.mjs';
beforeEach(async () => {
  spy = installFetch();
  await reset();
  files = publishedFiles();
  const v = (path: string, body: string) => files.set(`${SIDECAR}/v/${VERSION}/${path}`, body);
  for (const path of [...HASHED, ...PAGE_CHUNKS, MERMAID, MERMAID_CHUNK]) v(path, `/* ${path} */`);
  v('assets/app.js', 'unhashed');
  v('assets/logo.AbCd1234.png', 'png');
  v('assets/spec.pdf', 'pdf');
  v('vp-icons.css', 'icons');
  v('chunks/x.AbCd1234.js', 'outside assets');
  v('404.html', '<!doctype html><title>Page not found</title>');
  deps.store = memoryStore(files);
});
afterEach(() => spy.mockRestore());

const READER = 'riya@initech.example';
const get = (path: string, init: Record<string, unknown> = {}) =>
  call(`/${SIDECAR}/${path}`, { raw: true, email: READER, ...init });
const PUBLIC = (() => {
  const cfg = structuredClone(CONFIG) as typeof CONFIG & { sites: Record<string, unknown>[] };
  cfg.sites[0].visibility = 'public';
  return { envOverride: { SPECREVIEW_CONFIG: JSON.stringify(cfg) } };
})();

describe('104: which names are content-addressed', () => {
  it("Vite's hashed scripts and stylesheets, and Mermaid's versioned folder", () => {
    for (const p of [...HASHED, MERMAID, MERMAID_CHUNK]) expect(isContentAddressed(p), p).toBe(true);
  });
  it('nothing else', () => {
    for (const p of [
      'assets/app.js',
      'assets/logo.AbCd1234.png',
      'assets/spec.pdf',
      'vp-icons.css',
      'chunks/x.AbCd1234.js',
      'assets/mermaid/mermaid.esm.min.mjs',
      'assets/mermaid-12.2/mermaid.esm.min.mjs',
      'assets/mermaid-12.2.0/x.js',
      'assets/x.AbCd123.js',
      'assets/x.AbCd1234.js.html',
      'x/assets/a.AbCd1234.js',
      'x/assets/mermaid-12.2.0/a.mjs',
      'assets/A.AbCd1234.JS',
      ...PAGE_CHUNKS,
      'index.html',
    ])
      expect(isContentAddressed(p), p).toBe(false);
  });
});

describe('104: cache headers', () => {
  it('1: a content-addressed asset may be kept a year, privately; its other headers are unchanged', async () => {
    for (const path of [...HASHED, MERMAID, MERMAID_CHUNK]) {
      const r = await get(path);
      expect([r.status, r.headers.get('cache-control')], path).toEqual([200, CACHE_FOREVER]);
      expect(r.headers.get('x-content-type-options'), path).toBe('nosniff');
      expect(r.headers.get('content-security-policy'), path).toBe("default-src 'none'; sandbox");
    }
    expect((await get(MERMAID)).headers.get('content-type')).toBe('text/javascript; charset=utf-8');
  });

  it('2, 3: pages, images, PDFs, root files, unhashed or outside assets/, the API: never stored', async () => {
    for (const path of [
      ...PAGE_CHUNKS,
      PAGE,
      '',
      'assets/app.js',
      'assets/logo.AbCd1234.png',
      'assets/spec.pdf',
      'vp-icons.css',
      'chunks/x.AbCd1234.js',
    ]) {
      const r = await get(path);
      expect([r.status, r.headers.get('cache-control')], path).toEqual([200, 'private, no-store']);
    }
    const api = await call('/api/pages', { site: SIDECAR, email: READER });
    expect(api.headers.get('cache-control')).toBe('no-store');
  });

  it('2: a missing asset-shaped path gets the 404 page, never stored, GET and HEAD', async () => {
    for (const method of ['GET', 'HEAD']) {
      const r = await get('assets/missing.AbCd1234.js', { method });
      expect([r.status, r.headers.get('cache-control')], method).toEqual([404, 'private, no-store']);
    }
  });

  it('4: HEAD of a content-addressed asset has the same header and no body', async () => {
    const r = await get(MERMAID, { method: 'HEAD' });
    expect([r.status, r.headers.get('cache-control'), String(r.body)]).toEqual([200, CACHE_FOREVER, '']);
  });

  it('5, 6: on a public site the asset stays private and year-long, anonymous, cookie-only or signed in; pages keep a minute', async () => {
    for (const [who, opts] of [
      ['anonymous', {}],
      ['cookie only', { headers: { cookie: 'CF_Authorization=abc' } }],
      ['signed in', { email: READER }],
    ] as const) {
      for (const method of ['GET', 'HEAD']) {
        const r = await call(`/${SIDECAR}/${HASHED[0]}`, { raw: true, ...PUBLIC, ...opts, method });
        expect([r.status, r.headers.get('cache-control')], `${who} ${method}`).toEqual([200, CACHE_FOREVER]);
      }
    }
    const page = await call(`/${SIDECAR}/${PAGE}`, { raw: true, ...PUBLIC });
    expect(page.headers.get('cache-control')).toBe('public, max-age=60');
    const missing = await call(`/${SIDECAR}/assets/missing.AbCd1234.js`, { raw: true, ...PUBLIC });
    expect([missing.status, missing.headers.get('cache-control')]).toEqual([404, 'public, max-age=60']);
  });

  it('the header follows the name in whichever version is live (a carried asset has its own name and bytes)', async () => {
    const V2 = `${'c'.repeat(40)}-2`;
    const carried = 'assets/chunks/old.Zz9_Yy8-.js';
    files.set(`${SIDECAR}/v/${V2}/manifest.json`, files.get(`${SIDECAR}/v/${VERSION}/manifest.json`)!);
    files.set(`${SIDECAR}/v/${V2}/${carried}`, '/* carried */');
    files.set(`${SIDECAR}/current.json`, JSON.stringify({ version: V2, publishedAt: '2026-10-09T00:00:00.000Z' }));
    const r = await get(carried);
    expect([r.status, r.headers.get('cache-control'), String(r.body)]).toEqual([200, CACHE_FOREVER, '/* carried */']);
  });
});
