// Publishing (#5): one request per build, authenticated by a GitHub Actions
// OIDC token, written to the real local R2 bucket.
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { generateKeyPair } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Manifest } from '@specreview/shared';
import worker from '../src/index';
import {
  call,
  CONFIG,
  emptySites,
  githubKeys,
  HOST,
  installFetch,
  ORG,
  oidcToken,
  PUBLISH_SHA,
  reset,
  SIDECAR,
  testEnv,
  tokenFor,
  TIKITI,
  WORKFLOW,
} from './helpers';

let spy: ReturnType<typeof installFetch>;
beforeEach(async () => {
  spy = installFetch();
  await reset();
  await emptySites();
});
afterEach(() => spy.mockRestore());

const OLD = 'a'.repeat(40);
const OLD_TEXT = '# Company signup\n\nThe old text.\n';
const sha256 = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

const manifestFor = async (over: Partial<Manifest> = {}): Promise<Manifest> => ({
  commit: PUBLISH_SHA,
  builtAt: '2026-10-09T00:00:00.000Z',
  pages: {
    index: { title: 'Home', hash: 'h-index', issues: [], sections: [], history: [] },
    'onboarding/signup': {
      title: 'Company signup',
      hash: 'h-signup',
      issues: [52],
      sections: [{ id: 'limits', title: 'Limits', text: 'Three per account.' }],
      history: [
        {
          commit: OLD,
          date: '2026-10-01',
          author: 'Dev',
          pr: 1,
          path: 'onboarding/signup.md',
          hash: await sha256(OLD_TEXT),
        },
      ],
    },
  },
  ...over,
});

type Parts = Record<string, string>;
const bundleParts = async (
  manifest?: Manifest,
  assets: Parts = { 'site/assets/app.B1.js': 'console.log(1)' },
): Promise<Parts> => ({
  'site/manifest.json': JSON.stringify(manifest ?? (await manifestFor())),
  'site/index.html': '<!doctype html><title>Home</title>',
  'site/onboarding/signup.html': '<!doctype html><title>Signup</title>',
  ...assets,
  [`history/${OLD}/onboarding/signup.md`]: OLD_TEXT,
});
const formOf = (parts: Parts) => {
  const form = new FormData();
  for (const [name, text] of Object.entries(parts)) form.append(name, new Blob([text]), name.split('/').pop());
  return form;
};

const send = async (path: string, init: RequestInit, override = {}) => {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`${HOST}${path}`, init) as Request<unknown, IncomingRequestCfProperties>,
    testEnv(override),
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  const body = res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text;
  return { status: res.status, body };
};
const publishWith = async (token: string | null, parts?: Parts, repo = SIDECAR, override = {}) =>
  send(
    `/_publish/${repo}`,
    {
      method: 'POST',
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
      body: formOf(parts ?? (await bundleParts())),
    },
    override,
  );
const pointer = async (repo = SIDECAR) => {
  const obj = await env.SITES!.get(`${repo}/current.json`);
  return obj ? ((await obj.json()) as { version: string; runId: string }) : null;
};
const code = (r: { body: unknown }) => (r.body as { error?: { code?: string } }).error?.code;

describe('1, 8, 9: a publish', () => {
  it('writes the build, switches the pointer, and the site serves it', async () => {
    const r = await publishWith(await oidcToken());
    expect(r.status).toBe(200);
    const version = (r.body as { version: string }).version;
    expect(version).toMatch(new RegExp(`^${PUBLISH_SHA}-100-1-[0-9a-f]{8}$`));
    expect(await pointer()).toMatchObject({ version, runId: '100' });
    expect(await (await env.SITES!.get(`${SIDECAR}/v/${version}/onboarding/signup.html`))!.text()).toContain('Signup');
    expect(await (await env.SITES!.get(`${SIDECAR}/history/${OLD}/onboarding/signup.md`))!.text()).toBe(OLD_TEXT);
    // The deployed Worker reads the SITES bucket and serves the new version.
    const live = await send(`/${SIDECAR}/onboarding/signup`, {
      headers: { 'cf-access-jwt-assertion': await (await import('./helpers')).tokenFor('dev@inoltro.ai') },
    });
    expect(live.status).toBe(200);
    expect(String(live.body)).toContain('Signup');
  });

  it("carries the previous version's own assets, one generation", async () => {
    const first = await publishWith(
      await oidcToken({ run_id: '100' }),
      await bundleParts(undefined, { 'site/assets/a.js': 'A' }),
    );
    const second = await publishWith(
      await oidcToken({ run_id: '101' }),
      await bundleParts(undefined, { 'site/assets/b.js': 'B' }),
    );
    const third = await publishWith(
      await oidcToken({ run_id: '102' }),
      await bundleParts(undefined, { 'site/assets/c.js': 'C' }),
    );
    for (const r of [first, second, third]) expect(r.status).toBe(200);
    const v2 = (second.body as { version: string }).version;
    const v3 = (third.body as { version: string }).version;
    expect(await env.SITES!.get(`${SIDECAR}/v/${v2}/assets/a.js`)).not.toBeNull();
    expect(await env.SITES!.get(`${SIDECAR}/v/${v3}/assets/b.js`)).not.toBeNull();
    // a.js was carried into v2 but was not v2's own, so it stops there.
    expect(await env.SITES!.get(`${SIDECAR}/v/${v3}/assets/a.js`)).toBeNull();
  });

  it('history is served only as the live manifest records it', async () => {
    expect((await publishWith(await oidcToken({ run_id: '200' }))).status).toBe(200);
    const history = async () => {
      const r = await send(`/${SIDECAR}/_history/${OLD}/onboarding/signup.md`, {
        headers: { 'cf-access-jwt-assertion': await tokenFor('dev@inoltro.ai') },
      });
      return [r.status, r.body];
    };
    expect(await history()).toEqual([200, OLD_TEXT]);
    // An older run with other text for the same commit and path, and a
    // manifest hash to match, is refused and changes nothing readers see.
    const other = 'different text';
    const manifest = await manifestFor();
    manifest.pages['onboarding/signup'].history[0].hash = await sha256(other);
    const parts = { ...(await bundleParts(manifest)), [`history/${OLD}/onboarding/signup.md`]: other };
    expect(code(await publishWith(await oidcToken({ run_id: '199' }), parts))).toBe('SUPERSEDED');
    expect(await history()).toEqual([200, OLD_TEXT]);
    // A history object that does not hash to the live manifest's entry is not served.
    await env.SITES!.put(`${SIDECAR}/history/${OLD}/onboarding/signup.md`, 'tampered');
    expect((await history())[0]).toBe(404);
  });

  it('a history file starting with a byte-order mark is served, byte for byte', async () => {
    const withBom = '\uFEFF# Company signup\n\nSaved by a Windows editor.\n';
    const manifest = await manifestFor();
    manifest.pages['onboarding/signup'].history[0].hash = await sha256(withBom);
    const parts = { ...(await bundleParts(manifest)), [`history/${OLD}/onboarding/signup.md`]: withBom };
    expect((await publishWith(await oidcToken(), parts)).status).toBe(200);
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(`${HOST}/${SIDECAR}/_history/${OLD}/onboarding/signup.md`, {
        headers: { 'cf-access-jwt-assertion': await tokenFor('dev@inoltro.ai') },
      }) as Request<unknown, IncomingRequestCfProperties>,
      testEnv(),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect([...new Uint8Array(await res.arrayBuffer()).slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it("a build's own asset is never replaced by the previous version's file of the same name", async () => {
    await publishWith(
      await oidcToken({ run_id: '100' }),
      await bundleParts(undefined, { 'site/assets/app.js': 'OLD' }),
    );
    const r = await publishWith(
      await oidcToken({ run_id: '101' }),
      await bundleParts(undefined, { 'site/assets/app.js': 'NEW' }),
    );
    const version = (r.body as { version: string }).version;
    expect(await (await env.SITES!.get(`${SIDECAR}/v/${version}/assets/app.js`))!.text()).toBe('NEW');
  });
});

describe('2, 3, 13: who may publish', () => {
  it('2: no token, a malformed one, a wrong key, expired, wrong issuer, wrong audience: 401', async () => {
    const stranger = (await generateKeyPair('RS256')).privateKey;
    const tokens = [
      null,
      'not-a-jwt',
      await oidcToken({}, { key: stranger }),
      await oidcToken({}, { expiresIn: '-1m' }),
      await oidcToken({}, { iss: 'https://evil.example' }),
      await oidcToken({}, { aud: 'https://another-hub.example' }),
    ];
    for (const [i, t] of tokens.entries()) {
      const r = await publishWith(t);
      expect(r.status, `token ${i}`).toBe(401);
      expect(code(r)).toBe('UNAUTHORIZED');
    }
    expect(await pointer()).toBeNull();
  });

  it('3: a valid token for anything but this repo, workflow, branch and push: 403', async () => {
    const wrong: Record<string, unknown>[] = [
      { repository_id: '9999' },
      { repository_owner_id: '9999' },
      { repository: `${ORG}/other` },
      { repository: 'someone-else/sidecar' },
      { workflow_ref: undefined },
      { workflow_ref: `${ORG}/${SIDECAR}/.github/workflows/other.yml@refs/heads/develop` },
      { workflow_ref: `${ORG}/${SIDECAR}/${WORKFLOW}@refs/heads/feature` },
      { workflow_ref: `${ORG}/${SIDECAR}/${WORKFLOW}@refs/tags/v1` },
      { ref: 'refs/heads/main' },
      { ref: 'refs/tags/v1' },
      ...[
        'pull_request',
        'pull_request_target',
        'workflow_run',
        'workflow_dispatch',
        'schedule',
        'repository_dispatch',
        'dynamic',
      ].map((e) => ({ event_name: e })),
      { sha: 'short' },
      { run_id: 'x' },
      { jti: undefined },
      { jti: '' },
    ];
    for (const over of wrong) {
      const r = await publishWith(await oidcToken(over));
      expect(r.status, JSON.stringify(over)).toBe(403);
    }
    expect(await pointer()).toBeNull();
  });

  it('the workflow path is exact; owner and repo ignore case', async () => {
    const r = await publishWith(
      await oidcToken({ workflow_ref: `${ORG}/${SIDECAR}/.github/workflows/DOCS.yml@refs/heads/develop` }),
    );
    expect(r.status).toBe(403);
    const cased = await publishWith(
      await oidcToken({
        repository: 'Inoltrotech/Sidecar',
        workflow_ref: `Inoltrotech/Sidecar/${WORKFLOW}@refs/heads/develop`,
      }),
    );
    expect(cased.status).toBe(200);
  });

  it('if the token cannot be recorded, nothing is published (fail closed)', async () => {
    const real = env.DB;
    const failingDb = new Proxy(real, {
      get(target, prop) {
        if (prop !== 'prepare') {
          const value = Reflect.get(target, prop);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return (sql: string) => {
          if (!sql.includes('publish_tokens')) return target.prepare(sql);
          return { bind: () => ({ run: () => Promise.reject(new Error('D1_ERROR: network connection lost')) }) };
        };
      },
    }) as D1Database;
    const r = await publishWith(await oidcToken(), undefined, SIDECAR, { DB: failingDb });
    expect([r.status, code(r)]).toEqual([503, 'STORAGE_UNAVAILABLE']);
    expect(await pointer()).toBeNull();
    expect((await env.SITES!.list({ prefix: `${SIDECAR}/v/` })).objects).toEqual([]);
  });

  it('3: a site that requires an environment refuses a token without it or from another', async () => {
    const tikiti = {
      repository: `${ORG}/${TIKITI}`,
      repository_id: '2003',
      workflow_ref: `${ORG}/${TIKITI}/${WORKFLOW}@refs/heads/main`,
      ref: 'refs/heads/main',
    };
    expect((await publishWith(await oidcToken(tikiti), undefined, TIKITI)).status).toBe(403);
    expect((await publishWith(await oidcToken({ ...tikiti, environment: 'prod' }), undefined, TIKITI)).status).toBe(
      403,
    );
    expect((await publishWith(await oidcToken({ ...tikiti, environment: 'docs' }), undefined, TIKITI)).status).toBe(
      200,
    );
  });

  it('3: an unknown repo is 404; GET is 405; a token publishes once', async () => {
    expect((await publishWith(await oidcToken(), undefined, 'nope')).status).toBe(404);
    expect((await send(`/_publish/${SIDECAR}`, { method: 'GET' })).status).toBe(405);
    const t = await oidcToken();
    expect((await publishWith(t)).status).toBe(200);
    const again = await publishWith(t);
    expect([again.status, code(again)]).toEqual([409, 'TOKEN_USED']);
  });

  it('13: an Access token is not a publish token; readers are unaffected', async () => {
    const access = await (await import('./helpers')).tokenFor('dev@inoltro.ai');
    expect(
      (
        await send(`/_publish/${SIDECAR}`, {
          method: 'POST',
          headers: { 'cf-access-jwt-assertion': access },
          body: formOf(await bundleParts()),
        })
      ).status,
    ).toBe(401);
    expect((await call('/api/me', { email: 'dev@inoltro.ai' })).status).toBe(200);
  });
});

describe('4, 6, 10: the bundle is checked whole', () => {
  const refused: [string, () => Promise<Parts>][] = [
    [
      'no manifest',
      async () => {
        const p = await bundleParts();
        delete p['site/manifest.json'];
        return p;
      },
    ],
    ['a manifest that is not valid', async () => ({ ...(await bundleParts()), 'site/manifest.json': '{"pages":{}}' })],
    ['a manifest naming another commit', async () => bundleParts(await manifestFor({ commit: 'd'.repeat(40) }))],
    [
      'a page without its HTML',
      async () => {
        const p = await bundleParts();
        delete p['site/onboarding/signup.html'];
        return p;
      },
    ],
    [
      'a history file missing',
      async () => {
        const p = await bundleParts();
        delete p[`history/${OLD}/onboarding/signup.md`];
        return p;
      },
    ],
    [
      'a history file with other text',
      async () => ({ ...(await bundleParts()), [`history/${OLD}/onboarding/signup.md`]: 'changed' }),
    ],
    [
      'a history file the manifest does not list',
      async () => ({ ...(await bundleParts()), [`history/${OLD}/extra.md`]: 'x' }),
    ],
    ['a path with ..', async () => ({ ...(await bundleParts()), 'site/../x.html': 'x' })],
    ['a part outside site/ and history/', async () => ({ ...(await bundleParts()), 'other/x': 'x' })],
    ['history not under a commit', async () => ({ ...(await bundleParts()), 'history/abc/x.md': 'x' })],
  ];
  it.each(refused)('%s: 422, nothing written, pointer unchanged', async (_name, parts) => {
    const r = await publishWith(await oidcToken(), await parts());
    expect(r.status).toBe(422);
    expect(await pointer()).toBeNull();
    expect((await env.SITES!.list({ prefix: `${SIDECAR}/v/` })).objects).toEqual([]);
  });

  it('10: a body over 25 MB is 413, counted as it arrives', async () => {
    const big = new ReadableStream({
      start(controller) {
        const chunk = new Uint8Array(1024 * 1024);
        for (let i = 0; i < 26; i++) controller.enqueue(chunk);
        controller.close();
      },
    });
    const r = await send(`/_publish/${SIDECAR}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await oidcToken()}`, 'content-type': 'multipart/form-data; boundary=x' },
      body: big,
      // @ts-expect-error duplex is required for a streamed body
      duplex: 'half',
    });
    expect(r.status).toBe(413);
  });

  it('more than 5000 files is 413', async () => {
    const parts = await bundleParts();
    for (let i = 0; i < 5000; i++) parts[`site/f/${i}.txt`] = 'x';
    const r = await publishWith(await oidcToken(), parts);
    expect([r.status, code(r)]).toEqual([413, 'TOO_MANY_FILES']);
  });

  it('a body that is not multipart is 415', async () => {
    const r = await send(`/_publish/${SIDECAR}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await oidcToken()}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(r.status).toBe(415);
  });
});

describe('7, 11: the pointer', () => {
  it('7: a run older than the live one is not promoted', async () => {
    expect((await publishWith(await oidcToken({ run_id: '200' }))).status).toBe(200);
    const late = await publishWith(await oidcToken({ run_id: '199' }));
    expect([late.status, code(late)]).toEqual([409, 'SUPERSEDED']);
    expect((await pointer())!.runId).toBe('200');
  });

  it('run ids beyond 2^53 compare exactly; a rerun attempt of the same run publishes', async () => {
    expect((await publishWith(await oidcToken({ run_id: '90071992547409930' }))).status).toBe(200);
    expect((await publishWith(await oidcToken({ run_id: '90071992547409931' }))).status).toBe(200);
    expect((await publishWith(await oidcToken({ run_id: '90071992547409930' }))).status).toBe(409);
    const rerun = await publishWith(await oidcToken({ run_id: '90071992547409931', run_attempt: '2' }));
    expect(rerun.status).toBe(200);
    expect((rerun.body as { version: string }).version).toContain('-90071992547409931-2-');
  });

  it('the pointer moves only from the version it was read at (compare-and-set)', async () => {
    expect((await publishWith(await oidcToken({ run_id: '300' }))).status).toBe(200);
    const before = await env.SITES!.get(`${SIDECAR}/current.json`);
    // Someone else moves the pointer: a write conditioned on the old etag fails.
    await env.SITES!.put(`${SIDECAR}/current.json`, JSON.stringify({ version: 'x', publishedAt: 'x', runId: '300' }));
    const stale = await env.SITES!.put(`${SIDECAR}/current.json`, 'y', { onlyIf: { etagMatches: before!.etag } });
    expect(stale).toBeNull();
    const created = await env.SITES!.put(`${SIDECAR}/current.json`, 'z', {
      onlyIf: new Headers({ 'if-none-match': '*' }),
    });
    expect(created).toBeNull();
  });

  it('a publish that lands between reading and writing the pointer is not overwritten blindly', async () => {
    expect((await publishWith(await oidcToken({ run_id: '400' }))).status).toBe(200);
    // Another publish (run 401) moves the pointer just before this one writes.
    const real = env.SITES!;
    let interfered = false;
    let pointerWrites = 0;
    const racing = new Proxy(real, {
      get(target, prop) {
        if (prop !== 'put') {
          const value = Reflect.get(target, prop);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return async (key: string, value: unknown, options?: R2PutOptions) => {
          if (key.endsWith('/current.json')) {
            pointerWrites++;
            if (!interfered) {
              interfered = true;
              await target.put(key, JSON.stringify({ version: 'other', publishedAt: 'x', runId: '401' }));
            }
          }
          return target.put(key, value as string, options);
        };
      },
    }) as R2Bucket;
    const r = await publishWith(await oidcToken({ run_id: '402' }), undefined, SIDECAR, { SITES: racing });
    expect(r.status).toBe(200);
    // The first conditional write failed against the moved pointer and was retried.
    expect(pointerWrites).toBe(2);
    expect((await pointer())!.runId).toBe('402');
  });

  it('the first publish is created only if no pointer exists meanwhile', async () => {
    const real = env.SITES!;
    let pointerWrites = 0;
    let interfered = false;
    const racing = new Proxy(real, {
      get(target, prop) {
        if (prop !== 'put') {
          const value = Reflect.get(target, prop);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return async (key: string, value: unknown, options?: R2PutOptions) => {
          if (key.endsWith('/current.json')) {
            pointerWrites++;
            if (!interfered) {
              interfered = true;
              await target.put(key, JSON.stringify({ version: 'first', publishedAt: 'x', runId: '1' }));
            }
          }
          return target.put(key, value as string, options);
        };
      },
    }) as R2Bucket;
    const r = await publishWith(await oidcToken({ run_id: '5' }), undefined, SIDECAR, { SITES: racing });
    expect(r.status).toBe(200);
    expect(pointerWrites).toBe(2);
    expect((await pointer())!.runId).toBe('5');
  });

  it("GitHub's keys unreachable: 503, which the uploader retries", async () => {
    githubKeys.down = true;
    const r = await publishWith(await oidcToken());
    expect([r.status, code(r)]).toEqual([503, 'KEYS_UNAVAILABLE']);
  });

  it('used tokens older than a day are deleted', async () => {
    await env.DB.prepare('INSERT INTO publish_tokens (jti, site, used_at) VALUES (?, ?, ?)')
      .bind('ancient', 'x', Date.now() - 2 * 24 * 60 * 60 * 1000)
      .run();
    expect((await publishWith(await oidcToken())).status).toBe(200);
    const left = await env.DB.prepare("SELECT count(*) AS n FROM publish_tokens WHERE jti = 'ancient'").first<{
      n: number;
    }>();
    expect(left?.n).toBe(0);
  });

  it('11: without the bucket, 500 STORE_NOT_CONFIGURED and the token is not spent', async () => {
    const t = await oidcToken();
    const r = await publishWith(t, undefined, SIDECAR, { SITES: undefined });
    expect([r.status, code(r)]).toEqual([500, 'STORE_NOT_CONFIGURED']);
    expect((await publishWith(t)).status).toBe(200);
  });
});

describe('12: config', () => {
  it('a hub without ownerId, or a site without branch, repositoryId or workflow, is CONFIG_INVALID', async () => {
    const broken = (patch: (c: typeof CONFIG) => unknown) => ({
      SPECREVIEW_CONFIG: JSON.stringify(patch(structuredClone(CONFIG))),
    });
    for (const over of [
      broken((c) => ({ ...c, ownerId: undefined })),
      broken((c) => (((c.sites[0] as Record<string, unknown>).branch = undefined), c)),
      broken((c) => (((c.sites[0] as Record<string, unknown>).repositoryId = 2001), c)),
      broken((c) => (((c.sites[0] as Record<string, unknown>).workflow = 'docs.yml'), c)),
      broken((c) => (((c.sites[0] as Record<string, unknown>).repo = '_publish'), c)),
    ]) {
      const r = await publishWith(await oidcToken(), undefined, SIDECAR, over);
      expect(code(r)).toBe('CONFIG_INVALID');
    }
  });
});
