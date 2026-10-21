// #17: a missing page gets the site's own 404 page. Case numbers are the ticket's.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memoryStore } from '../src/store';
import { forgetManifests } from '../src/manifest';
import {
  call,
  CONFIG,
  deps,
  errorCode,
  installFetch,
  manifests,
  publishedFiles,
  reset,
  SIDECAR,
  VERSION,
} from './helpers';

let spy: ReturnType<typeof installFetch>;
beforeEach(async () => {
  spy = installFetch();
  await reset();
});
afterEach(() => spy.mockRestore());

const TEAM = 'dev@acme.dev';
const NOT_FOUND_HTML = '<!doctype html><html><head><title>404</title></head><body><p>PAGE NOT FOUND</p></body></html>';
// The site's own CSP is distinct from the default, so a 404 page that did not
// carry it would be caught.
const SITE_CSP = "default-src 'self'; script-src 'self' 'sha256-abc='";
const with404 = () => {
  const all = manifests();
  (all[SIDECAR] as { csp?: string }).csp = SITE_CSP;
  forgetManifests();
  const files = publishedFiles(all);
  files.set(`${SIDECAR}/v/${VERSION}/404.html`, NOT_FOUND_HTML);
  deps.store = memoryStore(files);
};
const get = (path: string, opts: Record<string, unknown> = {}) => call(path, { raw: true, email: TEAM, ...opts });

describe('17: the site 404 page', () => {
  it('1: a missing page gets the site 404 HTML, status 404, the protected headers and the manifest CSP', async () => {
    with404();
    const page = await get(`/${SIDECAR}/onboarding/signup`);
    const r = await get(`/${SIDECAR}/no-such-page`);
    expect(r.status).toBe(404);
    expect(String(r.body)).toBe(NOT_FOUND_HTML);
    expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('content-security-policy')).toBe(SITE_CSP);
    expect(page.headers.get('content-security-policy')).toBe(SITE_CSP);
  });

  it('2: a build without 404.html still answers the JSON 404', async () => {
    const r = await get(`/${SIDECAR}/no-such-page`);
    expect([r.status, errorCode(r)]).toEqual([404, 'NOT_FOUND']);
  });

  it('3: API and history paths keep the JSON 404', async () => {
    with404();
    const api = await get(`/${SIDECAR}/_api/missing`);
    expect([api.status, errorCode(api)]).toEqual([404, 'NOT_FOUND']);
    const history = await get(`/${SIDECAR}/_history/${'a'.repeat(40)}/missing.md`);
    expect([history.status, errorCode(history)]).toEqual([404, 'NOT_FOUND']);
  });

  it('4: HEAD of a missing page is 404 with the same headers and no body', async () => {
    with404();
    const r = await get(`/${SIDECAR}/no-such-page`, { method: 'HEAD' });
    expect([r.status, r.headers.get('content-type'), String(r.body)]).toEqual([404, 'text/html; charset=utf-8', '']);
  });

  it('5: manifest.json is never served; it gets the 404 page', async () => {
    with404();
    const r = await get(`/${SIDECAR}/manifest.json`);
    expect(r.status).toBe(404);
    expect(String(r.body)).toBe(NOT_FOUND_HTML);
  });

  it('6: on a public site without a sign-in, the 404 page is marked public and cacheable', async () => {
    with404();
    const cfg = structuredClone(CONFIG) as typeof CONFIG & { sites: Record<string, unknown>[] };
    cfg.sites[0].visibility = 'public';
    const r = await call(`/${SIDECAR}/no-such-page`, {
      raw: true,
      envOverride: { SPECREVIEW_CONFIG: JSON.stringify(cfg) },
    });
    expect([r.status, r.headers.get('cache-control')]).toEqual([404, 'public, max-age=60']);
    expect(String(r.body)).toContain('<meta name="specreview-visibility" content="public">');
  });

  it('7: someone who may not read the site gets 404 before anything is read', async () => {
    const reads: string[] = [];
    const inner = memoryStore(publishedFiles());
    deps.store = { get: async (k) => (reads.push(k), inner.get(k)) };
    expect((await get(`/${SIDECAR}/no-such-page`, { email: 'x@stranger.example' })).status).toBe(404);
    expect(reads).toEqual([]);
  });

  it('8: a store failure reading 404.html is the generic 503', async () => {
    const inner = memoryStore(publishedFiles());
    deps.store = {
      get: async (k) => {
        if (k.endsWith('/404.html')) throw new Error('bucket specreview-sites failed');
        return inner.get(k);
      },
    };
    const r = await get(`/${SIDECAR}/no-such-page`);
    expect([r.status, errorCode(r)]).toEqual([503, 'STORAGE_UNAVAILABLE']);
  });
});
