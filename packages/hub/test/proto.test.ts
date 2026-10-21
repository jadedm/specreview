// #112: prototypes accepted at publish, stored apart from the site, and served
// only on the prototype hostname. Case numbers are the ticket's.
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Manifest } from '@specreview/shared';
import worker from '../src/index';
import { POINTER_TTL_MS, setClockForTests } from '../src/manifest';
import { PROTO_CSP } from '../src/proto';
import {
  ADMIN_AUD,
  CONFIG,
  emptySites,
  HOST,
  HUB_AUD,
  installFetch,
  oidcToken,
  PROTO_AUD,
  PROTO_HOST,
  PUBLISH_SHA,
  reset,
  SIDECAR,
  testEnv,
  token,
} from './helpers';

let spy: ReturnType<typeof installFetch>;
let now = 1_000_000;
beforeEach(async () => {
  spy = installFetch();
  await reset();
  await emptySites();
  now = 1_000_000;
  setClockForTests(() => now);
});
afterEach(() => {
  spy.mockRestore();
  setClockForTests(() => Date.now());
});

const READER = 'riya@initech.example';
const sha256 = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

const PROTOS: Record<string, string> = {
  'product/x/Main.dc.html': '<!doctype html><html><body>PROTO-MARK<script src="support.js"></script></body></html>',
  'product/x/support.js': 'window.proto = 1;',
  'product/x/style.css': 'body { margin: 0 }',
  'product/x/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
  'product/x/README.md': '# Notes',
  'product/x/data.bin': 'raw',
  'product/x/folder/index.html': '<!doctype html><title>folder</title>',
};
const manifestWith = async (protos: Record<string, string>, over: Partial<Manifest> = {}): Promise<Manifest> => ({
  commit: PUBLISH_SHA,
  builtAt: '2026-10-17T00:00:00.000Z',
  pages: { index: { title: 'Home', hash: 'h-index', issues: [], sections: [], history: [] } },
  prototypes: await Promise.all(
    Object.keys(protos)
      .sort()
      .map(async (path) => ({ path, hash: await sha256(protos[path]) })),
  ),
  ...over,
});
const formOf = (parts: Record<string, string>) => {
  const form = new FormData();
  for (const [name, text] of Object.entries(parts)) form.append(name, new Blob([text]), name.split('/').pop());
  return form;
};
const partsFor = async (protos = PROTOS, manifest?: Manifest, extra: Record<string, string> = {}) => ({
  'site/manifest.json': JSON.stringify(manifest ?? (await manifestWith(protos))),
  'site/index.html': '<!doctype html><title>Home</title>',
  ...Object.fromEntries(Object.entries(protos).map(([p, t]) => [`proto/${p}`, t])),
  ...extra,
});
const fetchHub = async (url: string, init: RequestInit = {}, override = {}) => {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(url, init) as Request<unknown, IncomingRequestCfProperties>,
    testEnv(override),
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  const body = res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text;
  return { status: res.status, headers: res.headers, body };
};
const publish = async (parts: Record<string, string>, runId = '100', override = {}) =>
  fetchHub(
    `${HOST}/_publish/${SIDECAR}`,
    { method: 'POST', headers: { authorization: `Bearer ${await oidcToken({ run_id: runId })}` }, body: formOf(parts) },
    override,
  );
const proto = async (
  path: string,
  opts: { aud?: string | null; email?: string; method?: string } = {},
  override = {},
) => {
  const aud = opts.aud === undefined ? PROTO_AUD : opts.aud;
  const headers: Record<string, string> = {};
  if (aud) headers['cf-access-jwt-assertion'] = await token({ email: opts.email ?? READER, aud });
  return fetchHub(`${PROTO_HOST}${path}`, { method: opts.method ?? 'GET', headers }, override);
};
const pointer = async () => {
  const obj = await env.SITES!.get(`${SIDECAR}/current.json`);
  return obj ? ((await obj.json()) as { version: string }) : null;
};
const code = (r: { body: unknown }) => (r.body as { error?: { code?: string } }).error?.code;
const withoutProto = (() => {
  const { protoHostname: _p, accessProtoAud: _a, ...rest } = CONFIG;
  return { SPECREVIEW_CONFIG: JSON.stringify(rest) };
})();

describe('112: publishing prototypes', () => {
  it('2: stores them apart from the site, never under v/', async () => {
    const r = await publish(await partsFor());
    expect(r.status).toBe(200);
    const version = (r.body as { version: string }).version;
    expect(await (await env.SITES!.get(`${SIDECAR}/p/${version}/product/x/Main.dc.html`))!.text()).toContain(
      'PROTO-MARK',
    );
    expect(await env.SITES!.get(`${SIDECAR}/v/${version}/proto/product/x/Main.dc.html`)).toBeNull();
    expect(await env.SITES!.get(`${SIDECAR}/v/${version}/product/x/Main.dc.html`)).toBeNull();
  });

  it('3: a listed file missing, an unlisted part, a hash mismatch or a bad path is refused whole', async () => {
    const one = { 'a/b.html': 'B' };
    const cases: [string, Record<string, string>][] = [
      ['missing', { 'site/manifest.json': JSON.stringify(await manifestWith(one)), 'site/index.html': 'x' }],
      ['unlisted', await partsFor(one, await manifestWith(one), { 'proto/a/extra.js': 'e' })],
      ['mismatch', await partsFor({ 'a/b.html': 'changed' }, await manifestWith(one))],
      ['bad path', await partsFor(one, await manifestWith(one), { 'proto/a/../b.html': 'x' })],
    ];
    for (const [label, parts] of cases) {
      const r = await publish(parts);
      expect([r.status, code(r)], label).toEqual([422, 'INVALID_BUNDLE']);
    }
    expect(await pointer()).toBeNull();
  });

  it('3b: a prototype that cannot be stored stops the publish before the pointer moves', async () => {
    const real = env.SITES!;
    const failing = new Proxy(real, {
      get: (target, prop) =>
        prop === 'put'
          ? (key: string, value: unknown) => {
              if (key.includes('/p/')) throw new Error('bucket down');
              return target.put(key, value as ArrayBuffer);
            }
          : Reflect.get(target, prop, target),
    });
    const r = await publish(await partsFor(), '100', { SITES: failing as unknown as R2Bucket });
    expect([r.status, code(r)]).toEqual([503, 'STORAGE_UNAVAILABLE']);
    expect(await pointer()).toBeNull();
  });

  it('3c: prototype parts count toward the 5000-file limit', async () => {
    const parts: Record<string, string> = {};
    for (let i = 0; i < 5001; i++) parts[`proto/many/${i}.js`] = String(i);
    const r = await publish({ ...(await partsFor({})), ...parts });
    expect([r.status, code(r)]).toEqual([413, 'TOO_MANY_FILES']);
  });

  it('4b: a hub without a prototype hostname still takes a build without prototypes', async () => {
    const parts = {
      'site/manifest.json': JSON.stringify(await manifestWith({}, { prototypes: undefined })),
      'site/index.html': 'x',
    };
    expect((await publish(parts, '100', withoutProto)).status).toBe(200);
  });

  it('4: a hub without a prototype hostname refuses a build with prototypes', async () => {
    const r = await publish(await partsFor(), '100', withoutProto);
    expect([r.status, code(r)]).toEqual([422, 'INVALID_BUNDLE']);
    expect(JSON.stringify(r.body)).toContain('no prototype hostname');
  });
});

describe('112: the prototype hostname', () => {
  const published = async () => {
    const r = await publish(await partsFor());
    expect(r.status).toBe(200);
    return (r.body as { version: string }).version;
  };

  it('5, 7b: serves a listed file to a reader with this hostname’s sign-in, under the prototype policy', async () => {
    await published();
    const r = await proto(`/${SIDECAR}/product/x/Main.dc.html`);
    expect(r.status).toBe(200);
    expect(String(r.body)).toContain('PROTO-MARK');
    expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(r.headers.get('content-security-policy')).toBe(
      "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'",
    );
    expect(PROTO_CSP).toBe(r.headers.get('content-security-policy'));
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('referrer-policy')).toBe('same-origin');
  });

  it('16: types from the table, Markdown as text, anything else as bytes; the same headers on each', async () => {
    await published();
    for (const [path, type] of [
      ['support.js', 'text/javascript; charset=utf-8'],
      ['style.css', 'text/css; charset=utf-8'],
      ['icon.svg', 'image/svg+xml'],
      ['README.md', 'text/plain; charset=utf-8'],
      ['data.bin', 'application/octet-stream'],
    ]) {
      const r = await proto(`/${SIDECAR}/product/x/${path}`);
      expect([r.status, r.headers.get('content-type')], path).toEqual([200, type]);
      expect(r.headers.get('content-security-policy'), path).toBe(PROTO_CSP);
      expect(r.headers.get('cache-control'), path).toBe('private, no-store');
      expect(r.headers.get('x-content-type-options'), path).toBe('nosniff');
    }
  });

  it('12: a trailing slash is the folder’s index.html when listed', async () => {
    await published();
    expect((await proto(`/${SIDECAR}/product/x/folder/`)).status).toBe(200);
    expect((await proto(`/${SIDECAR}/product/x/`)).status).toBe(404);
  });

  it('6, 6b: other shapes and every other hub route are not here, before any sign-in', async () => {
    await published();
    for (const path of [
      `/${SIDECAR}`,
      `/${SIDECAR}/`,
      '/nosuch/x.html',
      `/${SIDECAR}//x.html`,
      '/_publish/sidecar',
      '/_admin/',
      `/${SIDECAR}/_history/${'a'.repeat(40)}/x.md`,
      `/${SIDECAR}/_signin`,
      `/${SIDECAR}/_api/me`,
    ]) {
      const r = await proto(path, { aud: null });
      expect([r.status, r.headers.get('content-type')], path).toEqual([404, 'text/html; charset=utf-8']);
      expect(String(r.body), path).toContain('Prototype not found');
    }
    expect((await proto(`/${SIDECAR}/product/x/unlisted.html`)).status).toBe(404);
  });

  // #125: the hostname alone leads to the docs; a miss is a page with the way back.
  it('125 1-3: the hostname alone redirects to the docs index, GET and HEAD only, before any sign-in', async () => {
    for (const method of ['GET', 'HEAD']) {
      const r = await proto('/', { aud: null, method });
      expect([r.status, r.headers.get('location'), r.headers.get('cache-control')], method).toEqual([
        302,
        `${HOST}/`,
        'private, no-store',
      ]);
    }
    const post = await proto('/', { aud: null, method: 'POST' });
    expect([post.status, post.headers.get('location')]).toEqual([404, null]);
  });

  it('125 4, 5, 8, 10: a miss is an HTML page naming nothing, linking the docs, with the protected headers', async () => {
    await published();
    const misses = [
      await proto('/nosuch/x.html', { aud: null }),
      await proto(`/${SIDECAR}/_api/me`, { aud: null }),
      await proto(`/${SIDECAR}/product/x/unlisted.html`),
    ];
    for (const r of misses) {
      expect(r.status).toBe(404);
      expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(r.headers.get('cache-control')).toBe('private, no-store');
      expect(r.headers.get('x-frame-options')).toBe('DENY');
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
      expect(r.headers.get('content-security-policy')).toMatch(/^default-src 'none'; style-src 'sha256-/);
      const body = String(r.body);
      expect(body).toContain(`<a href="${HOST}/">Go to the docs</a>`);
      expect(body).not.toContain(SIDECAR);
      expect(body).not.toContain(CONFIG.org);
      expect(body).not.toContain('<script');
    }
    const head = await proto(`/${SIDECAR}/product/x/unlisted.html`, { method: 'HEAD' });
    expect([head.status, String(head.body)]).toEqual([404, '']);
    // A path a configured site could serve still needs a sign-in first.
    expect((await proto(`/${SIDECAR}/product/x/unlisted.html`, { aud: null })).status).toBe(401);
  });

  it('7, 7b: no sign-in, or the docs or admin hostname’s sign-in, is refused', async () => {
    await published();
    const path = `/${SIDECAR}/product/x/Main.dc.html`;
    expect((await proto(path, { aud: null })).status).toBe(401);
    expect((await proto(path, { aud: HUB_AUD })).status).toBe(401);
    expect((await proto(path, { aud: ADMIN_AUD })).status).toBe(401);
  });

  it('8: someone who may not read the site, or a reader removed on the admin page, is refused', async () => {
    await published();
    const path = `/${SIDECAR}/product/x/Main.dc.html`;
    expect((await proto(path, { email: 'x@stranger.example' })).status).toBe(404);
    await env.DB.prepare(
      'INSERT INTO pending_removals (site, list, entry, removed_by, removed_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(`acme/${SIDECAR}`, 'readers', '@initech.example', 'owner@acme.dev', Date.now())
      .run();
    expect((await proto(path)).status).toBe(404);
  });

  it('#176: someone who may not read the site gets what a name that is not a site gets, for any method', async () => {
    await published();
    const shape = (r: { status: number; headers: Headers; body: unknown }) => [
      r.status,
      [...r.headers],
      String(r.body),
    ];
    for (const method of ['GET', 'HEAD', 'POST', 'PUT']) {
      const stranger = await proto(`/${SIDECAR}/product/x/Main.dc.html`, { email: 'x@stranger.example', method });
      const nowhere = await proto('/no-such-site/product/x/Main.dc.html', { email: 'x@stranger.example', method });
      expect(shape(stranger), method).toEqual(shape(nowhere));
      expect(stranger.status, method).toBe(404);
    }
  });

  it('9, 10: only GET and HEAD; HEAD is headers only', async () => {
    await published();
    const path = `/${SIDECAR}/product/x/Main.dc.html`;
    expect((await proto(path, { method: 'POST' })).status).toBe(405);
    expect((await proto(path, { method: 'PUT' })).status).toBe(405);
    const head = await proto(path, { method: 'HEAD' });
    expect([head.status, String(head.body), head.headers.get('content-security-policy')]).toEqual([200, '', PROTO_CSP]);
  });

  it('11: the docs hostname never serves a prototype', async () => {
    const version = await published();
    const docs = async (p: string) =>
      fetchHub(`${HOST}${p}`, {
        headers: { 'cf-access-jwt-assertion': await token({ email: READER, aud: HUB_AUD }) },
        redirect: 'manual',
      });
    for (const p of [`/${SIDECAR}/proto/product/x/Main.dc.html`, `/${SIDECAR}/p/${version}/product/x/Main.dc.html`]) {
      const r = await docs(p);
      expect(String(r.body), p).not.toContain('PROTO-MARK');
      expect(r.status, p).toBe(404);
    }
    // The prototype's own path is sent to the prototype hostname (#113), never served here.
    const own = await docs(`/${SIDECAR}/product/x/Main.dc.html`);
    expect([own.status, String(own.body)]).toEqual([302, '']);
    expect(own.headers.get('location')).toBe(`${PROTO_HOST}/${SIDECAR}/product/x/Main.dc.html`);
  });

  it('13, 13b: the live version only, after the pointer cache; never a version from the URL', async () => {
    const v1 = await published();
    const path = `/${SIDECAR}/product/x/Main.dc.html`;
    expect((await proto(path)).status).toBe(200);
    const r = await publish(await partsFor({ 'other/y.html': 'Y' }), '101');
    expect(r.status).toBe(200);
    expect((await proto(path)).status).toBe(200);
    now += POINTER_TTL_MS + 1;
    expect((await proto(path)).status).toBe(404);
    expect((await proto(`/${SIDECAR}/other/y.html`)).status).toBe(200);
    expect((await proto(`/${SIDECAR}/p/${v1}/product/x/Main.dc.html`)).status).toBe(404);
  });

  it('14: a public site’s prototypes still need a sign-in', async () => {
    await published();
    const cfg = structuredClone(CONFIG) as typeof CONFIG & { sites: Record<string, unknown>[] };
    cfg.sites[0].visibility = 'public';
    const r = await proto(
      `/${SIDECAR}/product/x/Main.dc.html`,
      { aud: null },
      { SPECREVIEW_CONFIG: JSON.stringify(cfg) },
    );
    expect(r.status).toBe(401);
  });
});

describe('112: the prototype hostname in the config', () => {
  it('1, 1b: goes with its audience and the docs hostname; works without an admin hostname', async () => {
    const { problemsIn, configOf } = await import('../src/config');
    const base = structuredClone(CONFIG) as Record<string, unknown>;
    expect(problemsIn(base)).toEqual([]);
    const noAdmin = { ...base };
    delete noAdmin.adminHostname;
    delete noAdmin.accessAdminAud;
    expect(problemsIn(noAdmin)).toEqual([]);
    expect(configOf(JSON.stringify(noAdmin)).proto).toEqual({
      hostname: 'proto.example.com',
      aud: PROTO_AUD,
      docsHostname: 'docs.example.com',
    });
    expect(configOf(JSON.stringify(noAdmin)).admin).toBeNull();
    for (const [patch, problem] of [
      [{ protoHostname: undefined }, 'protoHostname and accessProtoAud go together'],
      [{ accessProtoAud: undefined }, 'protoHostname and accessProtoAud go together'],
      [{ protoHostname: 'docs.example.com' }, 'protoHostname must differ from the docs and admin hostnames'],
      [{ protoHostname: 'admin.example.com' }, 'protoHostname must differ from the docs and admin hostnames'],
      [{ protoHostname: 'Proto.Example.com' }, 'protoHostname must be a bare lowercase hostname'],
      [{ accessProtoAud: HUB_AUD }, "accessProtoAud must be the prototype hostname's own Access application"],
      [{ accessProtoAud: ADMIN_AUD }, "accessProtoAud must be the prototype hostname's own Access application"],
      [{ accessProtoAud: 'has space' }, 'accessProtoAud is malformed'],
    ] as const) {
      const c = { ...base, ...patch } as Record<string, unknown>;
      for (const k of Object.keys(patch)) if ((patch as Record<string, unknown>)[k] === undefined) delete c[k];
      expect(problemsIn(c), JSON.stringify(patch)).toEqual([problem]);
    }
    const none = { ...noAdmin };
    delete none.protoHostname;
    delete none.accessProtoAud;
    delete none.hostname;
    expect(problemsIn(none)).toEqual([]);
    expect([configOf(JSON.stringify(none)).admin, configOf(JSON.stringify(none)).proto]).toEqual([null, null]);
    const noHostname = { ...noAdmin };
    delete noHostname.hostname;
    expect(problemsIn(noHostname)).toEqual(['hostname goes with adminHostname or protoHostname']);
  });
});

describe('113: a docs link into a prototype folder', () => {
  const docs = async (p: string, opts: { email?: string | null; method?: string } = {}, override = {}) => {
    const headers: Record<string, string> = {};
    if (opts.email !== null)
      headers['cf-access-jwt-assertion'] = await token({ email: opts.email ?? READER, aud: HUB_AUD });
    return fetchHub(`${HOST}${p}`, { method: opts.method ?? 'GET', headers, redirect: 'manual' }, override);
  };
  const published = async () => {
    const r = await publish(await partsFor());
    expect(r.status).toBe(200);
  };

  it('4-6, 10: a listed path is sent to the prototype hostname, query kept; a folder too; HEAD as well', async () => {
    await published();
    const r = await docs(`/${SIDECAR}/product/x/Main.dc.html?view=1`);
    expect([r.status, r.headers.get('location'), r.headers.get('cache-control')]).toEqual([
      302,
      `${PROTO_HOST}/${SIDECAR}/product/x/Main.dc.html?view=1`,
      'private, no-store',
    ]);
    const folder = await docs(`/${SIDECAR}/product/x/folder/`);
    expect([folder.status, folder.headers.get('location')]).toEqual([
      302,
      `${PROTO_HOST}/${SIDECAR}/product/x/folder/`,
    ]);
    const head = await docs(`/${SIDECAR}/product/x/Main.dc.html`, { method: 'HEAD' });
    expect([head.status, String(head.body)]).toEqual([302, '']);
  });

  it('7, 8: a path not listed, or a hub without a prototype hostname, gets the 404 page', async () => {
    await published();
    expect((await docs(`/${SIDECAR}/product/x/unlisted.html`)).status).toBe(404);
    const r = await docs(`/${SIDECAR}/product/x/Main.dc.html`, {}, withoutProto);
    expect(r.status).toBe(404);
  });

  it('9: no sign-in, or someone who may not read the site, gets no redirect', async () => {
    await published();
    expect((await docs(`/${SIDECAR}/product/x/Main.dc.html`, { email: null })).status).toBe(401);
    expect((await docs(`/${SIDECAR}/product/x/Main.dc.html`, { email: 'x@stranger.example' })).status).toBe(404);
  });

  it('a public site: an anonymous visitor is redirected, publicly cacheable for a minute like its pages', async () => {
    await published();
    const cfg = structuredClone(CONFIG) as typeof CONFIG & { sites: Record<string, unknown>[] };
    cfg.sites[0].visibility = 'public';
    const r = await docs(
      `/${SIDECAR}/product/x/Main.dc.html`,
      { email: null },
      { SPECREVIEW_CONFIG: JSON.stringify(cfg) },
    );
    expect([r.status, r.headers.get('location'), r.headers.get('cache-control')]).toEqual([
      302,
      `${PROTO_HOST}/${SIDECAR}/product/x/Main.dc.html`,
      'public, max-age=60',
    ]);
  });
});
