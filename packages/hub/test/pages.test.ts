// Serving a site's published pages from the store (#4), and the snapshot every
// request and reconcile takes of what is published.
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { forgetManifests, POINTER_TTL_MS, setClockForTests } from '../src/manifest';
import { memoryStore, type SiteStore } from '../src/store';
import {
  call,
  CONFIG,
  deps,
  errorCode,
  github,
  HUB_AUD,
  installFetch,
  LIVE_HASH,
  manifests,
  PAGE,
  publishedFiles,
  reconcile,
  reset,
  SIDECAR,
  TIKITI,
  token,
  VERSION,
} from './helpers';

let spy: ReturnType<typeof installFetch>;
let now = 1_000_000;
beforeEach(async () => {
  spy = installFetch();
  await reset();
  now = 1_000_000;
  setClockForTests(() => now);
});
afterEach(() => {
  spy.mockRestore();
  setClockForTests(() => Date.now());
});

const READER = 'riya@ariai.example';
const TEAM = 'dev@inoltro.ai';
const APPROVER = 'approver@inoltro.ai';
const STRANGER = 'x@stranger.example';
const V2 = `${'c'.repeat(40)}-2`;

type Hooks = { fail?: (key: string) => boolean; onRead?: (key: string) => void | Promise<void> };
// The test files behind a store that records every key read and can fail or
// pause on chosen keys.
const spyStore = (files: Map<string, string>, hooks: Hooks = {}) => {
  const reads: string[] = [];
  const inner = memoryStore(files);
  const store: SiteStore = {
    get: async (key) => {
      reads.push(key);
      await hooks.onRead?.(key);
      if (hooks.fail?.(key)) throw new Error(`bucket specreview-sites failed on ${key}`);
      return inner.get(key);
    },
  };
  deps.store = store;
  return { files, reads };
};
const pointerReads = (reads: string[], repo: string) => reads.filter((k) => k === `${repo}/current.json`).length;
const docsLabels = (repo: string, n: number) =>
  github.repos
    .get(repo)!
    .get(n)!
    .labels.filter((l) => l.startsWith('docs:'));
const configWith = (patch: (c: typeof CONFIG) => unknown) => ({
  SPECREVIEW_CONFIG: JSON.stringify(patch(structuredClone(CONFIG))),
});
// Publishes V2 of sidecar: its own body and a manifest where the page links
// #52 only, no longer #23.
const publishV2 = (files: Map<string, string>) => {
  const m = manifests()[SIDECAR];
  m.pages[PAGE] = { ...m.pages[PAGE], hash: 'hash-v2', issues: [52] };
  files.set(`${SIDECAR}/v/${V2}/manifest.json`, JSON.stringify(m));
  files.set(`${SIDECAR}/v/${V2}/${PAGE}.html`, '<!doctype html><title>sidecar v2</title>');
  files.set(`${SIDECAR}/current.json`, JSON.stringify({ version: V2, publishedAt: '2026-10-09T00:00:00.000Z' }));
};
const page = (
  path: string,
  email: string | null = READER,
  init: { method?: string; headers?: Record<string, string> } = {},
) => call(path, { raw: true, ...(email ? { email } : {}), ...init });

describe('3-5: pages and assets of the current version', () => {
  it('3: the index and a page', async () => {
    const index = await page(`/${SIDECAR}/`);
    expect(index.status).toBe(200);
    expect(String(index.body)).toContain('sidecar home');
    expect(index.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const signup = await page(`/${SIDECAR}/${PAGE}`);
    expect(signup.status).toBe(200);
    expect(String(signup.body)).toContain('sidecar signup');
  });

  it('4: a directory index and an asset', async () => {
    const { files } = spyStore(publishedFiles());
    files.set(`${SIDECAR}/v/${VERSION}/guide/index.html`, 'guide index');
    files.set(`${SIDECAR}/v/${VERSION}/assets/x.js`, 'console.log(1)');
    const dir = await page(`/${SIDECAR}/guide/`);
    expect([dir.status, String(dir.body)]).toEqual([200, 'guide index']);
    const asset = await page(`/${SIDECAR}/assets/x.js`);
    expect([asset.status, String(asset.body)]).toEqual([200, 'console.log(1)']);
    expect(asset.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
  });

  it('the manifest is never served: its history metadata is for the team', async () => {
    for (const email of [READER, TEAM]) {
      for (const method of ['GET', 'HEAD']) {
        expect((await page(`/${SIDECAR}/manifest.json`, email, { method })).status, `${email} ${method}`).toBe(404);
      }
    }
  });

  it('5: a missing page is 404', async () => {
    const r = await page(`/${SIDECAR}/nothing/here`);
    expect(r.status).toBe(404);
    expect(errorCode(r)).toBe('NOT_FOUND');
  });

  it('31: two repos at the same version string each serve their own files', async () => {
    expect(String((await page(`/${SIDECAR}/${PAGE}`)).body)).toContain('sidecar signup');
    expect(String((await page(`/${TIKITI}/${PAGE}`)).body)).toContain('tikiti signup');
  });
});

describe('6, 7, 18: who is refused, before anything is read', () => {
  it('18: someone who may not read the site gets 403 everywhere, with no store or database read', async () => {
    const { files, reads } = spyStore(publishedFiles());
    files.set(`${TIKITI}/current.json`, 'not json');
    files.delete(`${SIDECAR}/current.json`);
    const noDb = { DB: undefined as unknown as Env['DB'] };
    const paths = [
      `/${SIDECAR}/${PAGE}`,
      `/${SIDECAR}/missing`,
      `/${SIDECAR}/_api/status`,
      `/${SIDECAR}/_api/me`,
      `/${SIDECAR}/_history/${'a'.repeat(40)}/${PAGE}.md`,
      `/${TIKITI}/${PAGE}`,
    ];
    for (const path of paths) {
      const r = await call(path, { raw: true, email: STRANGER, envOverride: noDb });
      expect(r.status, path).toBe(403);
      expect(errorCode(r), path).toBe('FORBIDDEN');
    }
    expect(reads).toEqual([]);
  });

  it('7: no token, or a token for another Access application, is 401 on a page', async () => {
    expect((await page(`/${SIDECAR}/${PAGE}`, null)).status).toBe(401);
    const other = await token({ email: READER, aud: 'aud-other' });
    expect((await call(`/${SIDECAR}/${PAGE}`, { raw: true, token: other })).status).toBe(401);
  });

  it('8, 19: token emails are trimmed and lowercased; two @ is refused', async () => {
    const as = async (email: string) =>
      (await call(`/${SIDECAR}/${PAGE}`, { raw: true, token: await token({ email, aud: HUB_AUD }) })).status;
    expect(await as('Riya@ARIAI.example')).toBe(200);
    expect(await as('  riya@ariai.example ')).toBe(200);
    expect(await as('riya@x@ariai.example')).toBe(401);
    expect(await as('riya@ariai.example.evil')).toBe(403);
  });

  it('8, 19: an exact reader entry admits that address only', async () => {
    const override = configWith((c) => {
      c.sites[0].readers = ['pm@partner.example'];
      return c;
    });
    const status = async (email: string) =>
      (await call(`/${SIDECAR}/${PAGE}`, { raw: true, email, envOverride: override })).status;
    expect(await status('pm@partner.example')).toBe(200);
    expect(await status('pm+tag@partner.example')).toBe(403);
    expect(await status('pm2@partner.example')).toBe(403);
    expect(await status(READER)).toBe(403);
  });

  it('20: team and approvers listed as readers stay team and approver', async () => {
    const override = configWith((c) => {
      c.sites[0].readers = [TEAM, APPROVER, '@inoltro.ai'];
      return c;
    });
    expect((await call('/api/me', { email: TEAM, envOverride: override })).body).toMatchObject({ role: 'team' });
    expect((await call('/api/me', { email: APPROVER, envOverride: override })).body).toMatchObject({
      role: 'approver',
    });
  });
});

describe('9, 25-28: methods, resolution, types and headers', () => {
  it('9: the manifest CSP applies to pages and assets; absent means default-src self', async () => {
    expect((await page(`/${SIDECAR}/${PAGE}`)).headers.get('content-security-policy')).toBe("default-src 'self'");
    const all = manifests();
    (all[SIDECAR] as { csp?: string }).csp = "default-src 'self'; img-src https:";
    const { files } = spyStore(publishedFiles(all));
    forgetManifests();
    files.set(`${SIDECAR}/v/${VERSION}/a.css`, 'a{}');
    for (const path of [`/${SIDECAR}/${PAGE}`, `/${SIDECAR}/a.css`]) {
      expect((await page(path)).headers.get('content-security-policy'), path).toBe(
        "default-src 'self'; img-src https:",
      );
    }
  });

  it('25: POST and PUT on a page are 405; HEAD is headers only', async () => {
    const { files } = spyStore(publishedFiles());
    files.set(`${SIDECAR}/v/${VERSION}/assets/x.js`, 'x');
    expect((await page(`/${SIDECAR}/${PAGE}`, READER, { method: 'POST' })).status).toBe(405);
    expect((await page(`/${SIDECAR}/${PAGE}`, READER, { method: 'PUT' })).status).toBe(405);
    for (const path of [`/${SIDECAR}/${PAGE}`, `/${SIDECAR}/assets/x.js`]) {
      const head = await page(path, READER, { method: 'HEAD' });
      expect(head.status, path).toBe(200);
      expect(String(head.body), path).toBe('');
      expect(head.headers.get('cache-control'), path).toBe('private, no-store');
    }
  });

  it('25: a conditional request is never a 304, signed in or not', async () => {
    const headers = { 'if-none-match': '*', 'if-modified-since': 'Thu, 01 Jan 2026 00:00:00 GMT' };
    expect((await page(`/${SIDECAR}/${PAGE}`, null, { headers })).status).toBe(401);
    expect((await page(`/${SIDECAR}/${PAGE}`, STRANGER, { headers })).status).toBe(403);
    expect((await page(`/${SIDECAR}/${PAGE}`, READER, { headers })).status).toBe(200);
  });

  it('26: a/b.html wins over a/b/index.html and the file a/b; explicit names are served as is', async () => {
    const { files } = spyStore(publishedFiles());
    const v = `${SIDECAR}/v/${VERSION}`;
    files.set(`${v}/a/b.html`, 'b.html');
    files.set(`${v}/a/b/index.html`, 'b index');
    files.set(`${v}/a/b`, 'b file');
    files.set(`${v}/a/c/index.html`, 'c index');
    files.set(`${v}/a/d`, 'd file');
    files.set(`${v}/a/e.js`, 'e js');
    files.set(`${v}/release-1.2.html`, 'release page');
    files.set(`${v}/notes.v2/index.html`, 'dotted dir');
    files.set(`${v}/guide/node.js.html`, 'node page');
    files.set(`${v}/vue.js/index.html`, 'vue dir');
    files.set(`${v}/guide/node.js.html`, 'node page');
    files.set(`${v}/vue.js/index.html`, 'vue dir');
    expect(String((await page(`/${SIDECAR}/a/b`)).body)).toBe('b.html');
    expect(String((await page(`/${SIDECAR}/a/b.html`)).body)).toBe('b.html');
    expect(String((await page(`/${SIDECAR}/a/b/`)).body)).toBe('b index');
    expect(String((await page(`/${SIDECAR}/a/c`)).body)).toBe('c index');
    expect(String((await page(`/${SIDECAR}/a/d`)).body)).toBe('d file');
    expect(String((await page(`/${SIDECAR}/a/e.js`)).body)).toBe('e js');
    expect((await page(`/${SIDECAR}/a/e`)).status).toBe(404);
    // A dot in a clean URL is not a file type.
    expect(String((await page(`/${SIDECAR}/release-1.2`)).body)).toBe('release page');
    expect(String((await page(`/${SIDECAR}/notes.v2`)).body)).toBe('dotted dir');
    // A tail that looks like a file type falls back to the page when no such file exists.
    expect(String((await page(`/${SIDECAR}/guide/node.js`)).body)).toBe('node page');
    expect(String((await page(`/${SIDECAR}/vue.js`)).body)).toBe('vue dir');
    // A tail that looks like a file type falls back to the page when no such file exists.
    expect(String((await page(`/${SIDECAR}/guide/node.js`)).body)).toBe('node page');
    expect(String((await page(`/${SIDECAR}/vue.js`)).body)).toBe('vue dir');
    expect(String((await page(`/${SIDECAR}/a/e.js`)).body)).toBe('e js');
  });

  it('27: content types from the table; anything else downloads', async () => {
    const types: Record<string, string> = {
      html: 'text/html; charset=utf-8',
      css: 'text/css; charset=utf-8',
      js: 'text/javascript; charset=utf-8',
      mjs: 'text/javascript; charset=utf-8',
      json: 'application/json; charset=utf-8',
      map: 'application/json; charset=utf-8',
      svg: 'image/svg+xml',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
      gif: 'image/gif',
      ico: 'image/x-icon',
      woff: 'font/woff',
      woff2: 'font/woff2',
      txt: 'text/plain; charset=utf-8',
      xml: 'application/xml; charset=utf-8',
    };
    const { files } = spyStore(publishedFiles());
    for (const ext of [...Object.keys(types), 'exe', 'PHP']) files.set(`${SIDECAR}/v/${VERSION}/f.${ext}`, '1');
    files.set(`${SIDECAR}/v/${VERSION}/noext`, 'x');
    for (const [ext, type] of Object.entries(types)) {
      const r = await page(`/${SIDECAR}/f.${ext}`);
      expect(r.headers.get('content-type'), ext).toBe(type);
      expect(r.headers.get('content-disposition'), ext).toBeNull();
    }
    for (const path of ['f.exe', 'f.PHP', 'noext']) {
      const r = await page(`/${SIDECAR}/${path}`);
      expect(r.status, path).toBe(200);
      expect(r.headers.get('content-type'), path).toBe('application/octet-stream');
      expect(r.headers.get('content-disposition'), path).toBe('attachment');
    }
  });

  it('28: security and cache headers on every kind of response', async () => {
    const { files } = spyStore(publishedFiles());
    files.set(`${SIDECAR}/v/${VERSION}/x.png`, 'png');
    const responses = {
      html: await page(`/${SIDECAR}/${PAGE}`),
      asset: await page(`/${SIDECAR}/x.png`),
      index: await page(`/${SIDECAR}/`),
      head: await page(`/${SIDECAR}/${PAGE}`, READER, { method: 'HEAD' }),
      missing: await page(`/${SIDECAR}/nope`),
      unsigned: await page(`/${SIDECAR}/${PAGE}`, null),
      refused: await page(`/${SIDECAR}/${PAGE}`, STRANGER),
    };
    for (const [name, r] of Object.entries(responses)) {
      expect(r.headers.get('cache-control'), name).toMatch(/no-store/);
      expect(r.headers.get('x-content-type-options'), name).toBe('nosniff');
      expect(r.headers.get('x-frame-options'), name).toBe('DENY');
      expect(r.headers.get('referrer-policy'), name).toBe('same-origin');
      expect(r.headers.get('content-security-policy'), name).toBeTruthy();
    }
    expect(responses.html.headers.get('cache-control')).toBe('private, no-store');
  });
});

describe('10, 11, 24: paths', () => {
  it('only plain segments under a known site reach a page', async () => {
    // Files at the keys a doubled slash would reach, so a 404 is the router's.
    const { files } = spyStore(publishedFiles());
    files.set(`${SIDECAR}/v/${VERSION}//x.html`, 'doubled');
    files.set(`${SIDECAR}/v/${VERSION}/a//b.html`, 'doubled');
    // And files a build could emit under the reserved names.
    for (const name of ['_api.html', '_api/index.html', '_history.html', '_history/index.html']) {
      files.set(`${SIDECAR}/v/${VERSION}/${name}`, 'reserved');
    }
    const notFound = [
      `/${SIDECAR}`,
      `/${SIDECAR}//x`,
      `/${SIDECAR}/a//b`,
      `/${SIDECAR}/onboarding%2Fsignup`,
      `/${SIDECAR}/onboarding%5Csignup`,
      `/${SIDECAR}/_api`,
      `/${SIDECAR}/_api/`,
      `/${SIDECAR}/_history`,
      `/${SIDECAR}/_history/`,
      `/${SIDECAR}/a%00b`,
      `/${SIDECAR}/a b`,
    ];
    for (const path of notFound) expect((await page(path, TEAM)).status, path).toBe(404);
    // Dot segments resolve before routing: this is /sidecar/onboarding/signup.
    expect((await page(`/${SIDECAR}/x/../${PAGE}`, READER)).status).toBe(200);
  });

  it('11: an unknown site is 404 before identity, without a token', async () => {
    const r = await page('/nosuchrepo/', null);
    expect(r.status).toBe(404);
  });
});

describe('12-14, 29-30, 32-35: what is published, and one snapshot of it', () => {
  it('12, 32: a new publish shows within the pointer cache, never mixed', async () => {
    const { files } = spyStore(publishedFiles());
    expect(String((await page(`/${SIDECAR}/${PAGE}`)).body)).toContain('sidecar signup');
    publishV2(files);
    now += POINTER_TTL_MS - 1;
    expect(String((await page(`/${SIDECAR}/${PAGE}`)).body)).toContain('sidecar signup');
    now += 1;
    expect(String((await page(`/${SIDECAR}/${PAGE}`)).body)).toContain('sidecar v2');
  });

  it('13, 32: never published is 503 and is not cached once published', async () => {
    const { files } = spyStore(publishedFiles());
    const pointer = files.get(`${SIDECAR}/current.json`)!;
    files.delete(`${SIDECAR}/current.json`);
    const before = await page(`/${SIDECAR}/${PAGE}`);
    expect([before.status, errorCode(before)]).toEqual([503, 'SITE_NOT_PUBLISHED']);
    files.set(`${SIDECAR}/current.json`, pointer);
    expect((await page(`/${SIDECAR}/${PAGE}`)).status).toBe(200);
  });

  it('13: an unpublished site links nothing, so the reconcile clears its labels', async () => {
    const { files } = spyStore(publishedFiles());
    github.issues.get(52)!.labels.push('docs: in review');
    files.delete(`${SIDECAR}/current.json`);
    expect((await reconcile())['inoltrotech/sidecar']).not.toBe('failed');
    expect(docsLabels('inoltrotech/sidecar', 52)).toEqual([]);
  });

  it('14, 29: a broken pointer is 503 SITE_BROKEN and fails the label sync without clearing anything', async () => {
    const pointers = [
      '',
      'not json',
      '[]',
      'null',
      '{}',
      JSON.stringify({ version: 5, publishedAt: 'x' }),
      JSON.stringify({ version: VERSION }),
      JSON.stringify({ version: `${VERSION}/x`, publishedAt: 'x' }),
      JSON.stringify({ version: '..', publishedAt: 'x' }),
      JSON.stringify({ version: `${'b'.repeat(40)}%2F1`, publishedAt: 'x' }),
      JSON.stringify({ version: `${'b'.repeat(40)}\\1`, publishedAt: 'x' }),
      JSON.stringify({ version: `${'B'.repeat(40)}-1`, publishedAt: 'x' }),
      JSON.stringify({ version: 'b'.repeat(40), publishedAt: 'x' }),
    ];
    for (const text of pointers) {
      await reset();
      const { files, reads } = spyStore(publishedFiles());
      files.set(`${SIDECAR}/current.json`, text);
      github.issues.get(52)!.labels.push('docs: in review');
      const r = await page(`/${SIDECAR}/${PAGE}`);
      expect([r.status, errorCode(r)], text).toEqual([503, 'SITE_BROKEN']);
      expect(
        reads.filter((k) => k.startsWith(`${SIDECAR}/v/`)),
        text,
      ).toEqual([]);
      expect((await reconcile())['inoltrotech/sidecar'], text).toBe('failed');
      expect(docsLabels('inoltrotech/sidecar', 52), text).toEqual(['docs: in review']);
    }
  });

  it('14, 30: a missing or malformed manifest is 503 SITE_BROKEN', async () => {
    const page0 = manifests()[SIDECAR].pages[PAGE];
    const bad: [string, (m: Record<string, unknown>) => unknown][] = [
      ['missing', () => undefined],
      ['not json', () => '{'],
      ['pages not an object', (m) => ({ ...m, pages: [] })],
      ['page without title', (m) => ({ ...m, pages: { [PAGE]: { ...page0, title: 1 } } })],
      ['page without hash', (m) => ({ ...m, pages: { [PAGE]: { ...page0, hash: undefined } } })],
      ['duplicate issues', (m) => ({ ...m, pages: { [PAGE]: { ...page0, issues: [52, 52] } } })],
      ['issue zero', (m) => ({ ...m, pages: { [PAGE]: { ...page0, issues: [0] } } })],
      ['bad section', (m) => ({ ...m, pages: { [PAGE]: { ...page0, sections: [{ id: 'a' }] } } })],
      ['issue past 2^53', (m) => ({ ...m, pages: { [PAGE]: { ...page0, issues: [1e21] } } })],
      ['hash over 100 characters', (m) => ({ ...m, pages: { [PAGE]: { ...page0, hash: 'h'.repeat(101) } } })],
      ['hash with a tab', (m) => ({ ...m, pages: { [PAGE]: { ...page0, hash: 'h\th' } } })],
      ['blank hash', (m) => ({ ...m, pages: { [PAGE]: { ...page0, hash: '   ' } } })],
      ['hash with a tab', (m) => ({ ...m, pages: { [PAGE]: { ...page0, hash: 'h\th' } } })],
      ['blank hash', (m) => ({ ...m, pages: { [PAGE]: { ...page0, hash: '   ' } } })],
      ['empty hash', (m) => ({ ...m, pages: { [PAGE]: { ...page0, hash: '' } } })],
      ['issue as a string', (m) => ({ ...m, pages: { [PAGE]: { ...page0, issues: ['52'] } } })],
      [
        'duplicate section ids',
        (m) => ({ ...m, pages: { [PAGE]: { ...page0, sections: [page0.sections[0], page0.sections[0]] } } }),
      ],
      [
        'history path not a string',
        (m) => ({ ...m, pages: { [PAGE]: { ...page0, history: [{ ...page0.history[0], path: 1 }] } } }),
      ],
      [
        'history hash not a string',
        (m) => ({ ...m, pages: { [PAGE]: { ...page0, history: [{ ...page0.history[0], hash: null }] } } }),
      ],
      [
        'bad history commit',
        (m) => ({ ...m, pages: { [PAGE]: { ...page0, history: [{ ...page0.history[0], commit: 'abc' }] } } }),
      ],
      ['empty csp', (m) => ({ ...m, csp: '' })],
      ['csp with a newline', (m) => ({ ...m, csp: "default-src 'self'\nscript-src *" })],
      ['csp of spaces', (m) => ({ ...m, csp: '   ' })],
      ['missing commit', (m) => ({ ...m, commit: undefined })],
      ['short commit', (m) => ({ ...m, commit: 'abc' })],
      ['builtAt not a string', (m) => ({ ...m, builtAt: 1 })],
      ['csp not a string', (m) => ({ ...m, csp: 1 })],
    ];
    for (const [name, patch] of bad) {
      await reset();
      const { files } = spyStore(publishedFiles());
      const key = `${SIDECAR}/v/${VERSION}/manifest.json`;
      const out = patch(JSON.parse(files.get(key)!) as Record<string, unknown>);
      if (out === undefined) files.delete(key);
      else files.set(key, typeof out === 'string' ? out : JSON.stringify(out));
      const r = await page(`/${SIDECAR}/${PAGE}`);
      expect([r.status, errorCode(r)], name).toEqual([503, 'SITE_BROKEN']);
    }
  });

  it('33: concurrent requests after expiry share one slow pointer read', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { reads } = spyStore(publishedFiles(), {
      onRead: (key) => (key === `${SIDECAR}/current.json` ? gate : undefined),
    });
    const pending = [1, 2, 3].map(() => page(`/${SIDECAR}/${PAGE}`));
    await new Promise((r) => setTimeout(r, 20));
    release();
    const results = await Promise.all(pending);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(pointerReads(reads, SIDECAR)).toBe(1);
  });

  it('34: a publish during a request does not change what that request serves', async () => {
    const files = publishedFiles();
    let flipped = false;
    spyStore(files, {
      // Publish once the request has read the pointer: it keeps that version
      // for its body, even though the cache has expired.
      onRead: (key) => {
        if (key !== `${SIDECAR}/v/${VERSION}/manifest.json` || flipped) return;
        flipped = true;
        publishV2(files);
        now += POINTER_TTL_MS * 2;
      },
    });
    const r = await page(`/${SIDECAR}/${PAGE}`);
    expect(String(r.body)).toContain('sidecar signup');
    expect(String((await page(`/${SIDECAR}/${PAGE}`)).body)).toContain('sidecar v2');
  });

  it('35: a status change and a reconcile each read every pointer once', async () => {
    // Every pointer read moves the clock past the cache, so a second snapshot
    // in the same request or reconcile would read again and see V2.
    const files = publishedFiles();
    const { reads } = spyStore(files, {
      onRead: (key) => {
        if (key.endsWith('/current.json')) now += POINTER_TTL_MS * 2;
      },
    });
    files.set(`${SIDECAR}/v/${V2}/manifest.json`, 'not read');
    const r = await call('/api/status', {
      email: APPROVER,
      body: { page: PAGE, status: 'ready', expectedVersion: 0, hash: LIVE_HASH },
    });
    expect(r.status).toBe(200);
    expect(pointerReads(reads, SIDECAR)).toBe(1);
    expect(docsLabels('inoltrotech/sidecar', 23)).toEqual(['docs: ready to build']);
    reads.length = 0;
    publishV2(files);
    expect((await reconcile())['inoltrotech/sidecar']).toBe('updated');
    for (const repo of [SIDECAR, 'web', TIKITI]) expect(pointerReads(reads, repo), repo).toBe(1);
    // The reconcile used V2 throughout: #23 is no longer linked.
    expect(docsLabels('inoltrotech/sidecar', 23)).toEqual([]);
  });
});

describe('16, 36: storage failures', () => {
  const failing: [string, string, (key: string) => boolean, string][] = [
    ['pointer', `/${SIDECAR}/${PAGE}`, (k) => k === `${SIDECAR}/current.json`, READER],
    ['manifest', `/${SIDECAR}/${PAGE}`, (k) => k.endsWith('/manifest.json'), READER],
    ['page', `/${SIDECAR}/${PAGE}`, (k) => k.endsWith(`${PAGE}.html`), READER],
    ['fallback candidate', `/${SIDECAR}/onboarding/approval`, (k) => k.endsWith('approval/index.html'), READER],
    ['history', `/${SIDECAR}/_history/${'a'.repeat(40)}/${PAGE}.md`, (k) => k.includes('/history/'), TEAM],
  ];
  for (const [name, path, fail, email] of failing) {
    it(`${name}: a generic 503 with nothing about the store in it, and no label writes`, async () => {
      spyStore(publishedFiles(), { fail });
      const r = await call(path, { raw: true, email });
      expect([r.status, errorCode(r)]).toEqual([503, 'STORAGE_UNAVAILABLE']);
      expect(JSON.stringify(r.body)).not.toMatch(/specreview-sites|current\.json|manifest|history|bucket/);
      expect(github.calls.filter((c) => !c.startsWith('GET '))).toEqual([]);
    });
  }

  it('a status change whose snapshot fails writes no status and no label', async () => {
    spyStore(publishedFiles(), { fail: (k) => k.endsWith('/manifest.json') });
    const r = await call('/api/status', {
      email: APPROVER,
      body: { page: PAGE, status: 'ready', expectedVersion: 0, hash: LIVE_HASH },
    });
    expect(r.status).toBe(503);
    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM page_status').first<{ n: number }>();
    expect(rows?.n).toBe(0);
    expect(github.calls.filter((c) => !c.startsWith('GET '))).toEqual([]);
  });
});
