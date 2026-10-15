// #20: public sites, readable without sign-in. Case numbers are the ticket's.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { problemsIn } from '../src/config';
import { memoryStore } from '../src/store';
import {
  call,
  CONFIG,
  deps,
  errorCode,
  GLOBEX,
  installFetch,
  PAGE,
  publishedFiles,
  reset,
  SIDECAR,
  tokenFor,
  VERSION,
} from './helpers';

let spy: ReturnType<typeof installFetch>;
beforeEach(async () => {
  spy = installFetch();
  await reset();
  // Pages as VitePress writes them, with a head, on both sites.
  const files = publishedFiles();
  for (const repo of [SIDECAR, GLOBEX]) {
    files.set(
      `${repo}/v/${VERSION}/${PAGE}.html`,
      `<!doctype html><html><head><title>${repo} signup</title></head><body><p>${repo} signup</p></body></html>`,
    );
  }
  deps.store = memoryStore(files);
});
afterEach(() => spy.mockRestore());

// sidecar public; globex (another team) stays private on the same hub.
const PUBLIC = (() => {
  const cfg = structuredClone(CONFIG) as typeof CONFIG & { sites: Record<string, unknown>[] };
  cfg.sites[0].visibility = 'public';
  return { envOverride: { SPECREVIEW_CONFIG: JSON.stringify(cfg) } };
})();
const META = '<meta name="specreview-visibility" content="public">';
const anon = (path: string, opts: Record<string, unknown> = {}) => call(path, { raw: true, ...PUBLIC, ...opts });

describe('20: visibility in the config', () => {
  it('1: missing, private and public are valid; anything else is refused', () => {
    for (const v of [undefined, 'private', 'public']) {
      const cfg = structuredClone(CONFIG) as typeof CONFIG & { sites: Record<string, unknown>[] };
      if (v) cfg.sites[0].visibility = v;
      expect(problemsIn(cfg), String(v)).toEqual([]);
    }
    const bad = structuredClone(CONFIG) as typeof CONFIG & { sites: Record<string, unknown>[] };
    bad.sites[0].visibility = 'open';
    expect(problemsIn(bad)).toEqual(['sites[0].visibility must be public or private']);
  });
});

describe('20: a public site without a sign-in', () => {
  it('2: a page is served, cacheable for a minute, marked public in its head', async () => {
    const r = await anon(`/${SIDECAR}/${PAGE}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('public, max-age=60');
    expect(String(r.body)).toContain(META);
    expect(String(r.body).indexOf(META)).toBeLessThan(String(r.body).indexOf('</head>'));
  });

  it('2: HEAD has the same headers and no body', async () => {
    const r = await anon(`/${SIDECAR}/${PAGE}`, { method: 'HEAD' });
    expect([r.status, r.headers.get('cache-control'), String(r.body)]).toEqual([200, 'public, max-age=60', '']);
  });

  it('3: an asset is served as stored, cacheable, never rewritten', async () => {
    const files = publishedFiles();
    files.set(`${SIDECAR}/v/${VERSION}/assets/app.js`, 'console.log("<head></head>")');
    deps.store = memoryStore(files);
    const r = await anon(`/${SIDECAR}/assets/app.js`);
    expect([r.status, r.headers.get('cache-control')]).toEqual([200, 'public, max-age=60']);
    expect(String(r.body)).toBe('console.log("<head></head>")');
    // #77: served without a sign-in, it still runs nothing on its own.
    expect(r.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
  });

  it('review: a POST to a public page without a sign-in is 401', async () => {
    expect((await anon(`/${SIDECAR}/${PAGE}`, { method: 'POST', body: {} })).status).toBe(401);
  });

  it('4, 5: the API and old versions still need a sign-in; nothing is written', async () => {
    for (const path of [
      '/api/me',
      '/api/status',
      `/api/comments?page=${encodeURIComponent(PAGE)}`,
      `/_history/${'a'.repeat(40)}/${PAGE}.md`,
    ]) {
      const r = await call(path, { site: SIDECAR, ...PUBLIC });
      expect(r.status, path).toBe(401);
    }
    const post = await call('/api/comments', {
      site: SIDECAR,
      ...PUBLIC,
      body: { page: PAGE, heading: 'limits', quote: 'q', body: 'b' },
    });
    expect(post.status).toBe(401);
    const list = await call(`/api/comments?page=${encodeURIComponent(PAGE)}`, {
      site: SIDECAR,
      email: 'dev@acme.dev',
      ...PUBLIC,
    });
    expect(list.body).toEqual([]);
  });

  it('6: a present but invalid assertion is 401, never anonymous', async () => {
    expect((await anon(`/${SIDECAR}/${PAGE}`, { token: 'not-a-jwt' })).status).toBe(401);
  });

  it('7: a signed-in visitor whose page request carries no assertion gets the same public page', async () => {
    const plain = await anon(`/${SIDECAR}/${PAGE}`);
    const withCookie = await anon(`/${SIDECAR}/${PAGE}`, { headers: { cookie: 'CF_Authorization=abc' } });
    expect([withCookie.status, withCookie.headers.get('cache-control')]).toEqual([200, 'public, max-age=60']);
    expect(String(withCookie.body)).toBe(String(plain.body));
  });

  it('7: with an assertion, the page is marked public but never shared-cacheable', async () => {
    const r = await anon(`/${SIDECAR}/${PAGE}`, { email: 'dev@acme.dev' });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect(String(r.body)).toContain(META);
  });

  it('8, 9: a private site on the same hub still refuses a request with no sign-in, and is not marked', async () => {
    expect((await anon(`/${GLOBEX}/${PAGE}`)).status).toBe(401);
    const signedIn = await anon(`/${GLOBEX}/${PAGE}`, { email: 'pm@globex.dev' });
    expect(String(signedIn.body)).not.toContain(META);
    expect(signedIn.headers.get('cache-control')).toBe('private, no-store');
  });

  it('8: with the default config (every site private) nothing changes', async () => {
    expect((await call(`/${SIDECAR}/${PAGE}`, { raw: true })).status).toBe(401);
  });

  it('a missing page on a public site is a 404, not served', async () => {
    const r = await anon(`/${SIDECAR}/no-such-page`);
    expect([r.status, errorCode(r)]).toEqual([404, 'NOT_FOUND']);
  });
});

describe('20: signing in on a public site', () => {
  it('10: /<repo>/_signin sends a signed-in visitor to the site; without a token it is 401', async () => {
    const r = await anon(`/${SIDECAR}/_signin`, { token: await tokenFor('dev@acme.dev') });
    expect([r.status, r.headers.get('location'), r.headers.get('cache-control')]).toEqual([
      302,
      `/${SIDECAR}/`,
      'private, no-store',
    ]);
    expect((await anon(`/${SIDECAR}/_signin`)).status).toBe(401);
    expect((await anon(`/${SIDECAR}/_signin/x`, { email: 'dev@acme.dev' })).status).toBe(404);
  });

  it('10: someone who may not read the site gets 403 at _signin', async () => {
    expect((await anon(`/${SIDECAR}/_signin`, { email: 'x@stranger.example' })).status).toBe(403);
  });
});
