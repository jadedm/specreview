import { jwtVerify, decodeProtectedHeader, decodeJwt } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appAuth, appJwt, importAppKey, pkcs8FromPkcs1 } from '../src/github-app';
import { envTokens } from '../src/github-auth';
import { appStub, call, deps, github, installFetch, LIVE_HASH, PAGE, reset } from './helpers';

const APP_ID = '123456';
const keys = (await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true,
  ['sign', 'verify'],
)) as CryptoKeyPair;
const pkcs8 = new Uint8Array((await crypto.subtle.exportKey('pkcs8', keys.privateKey)) as ArrayBuffer);

// The PKCS#1 key inside a PKCS#8 one: the content of its OCTET STRING.
const tlv = (b: Uint8Array, at: number) => {
  const first = b[at + 1];
  const lenBytes = first & 0x80 ? first & 0x7f : 0;
  let len = lenBytes ? 0 : first;
  for (let i = 0; i < lenBytes; i++) len = (len << 8) | b[at + 2 + i];
  const start = at + 2 + lenBytes;
  return { start, end: start + len };
};
const pkcs1Of = (b: Uint8Array) => {
  const outer = tlv(b, 0);
  const version = tlv(b, outer.start);
  const algorithm = tlv(b, version.end);
  const octets = tlv(b, algorithm.end);
  return b.slice(octets.start, octets.end);
};
const pem = (label: string, bytes: Uint8Array) =>
  `-----BEGIN ${label}-----\n${btoa(String.fromCharCode(...bytes))
    .match(/.{1,64}/g)!
    .join('\n')}\n-----END ${label}-----\n`;
const PKCS8_PEM = pem('PRIVATE KEY', pkcs8);
const PKCS1_PEM = pem('RSA PRIVATE KEY', pkcs1Of(pkcs8));
const KEY_TEXT = PKCS1_PEM.split('\n')[2];

let spy: ReturnType<typeof installFetch>;
let lines: string[];
let clock: number;
beforeEach(async () => {
  spy = installFetch();
  await reset();
  github.app = appStub(APP_ID, keys.publicKey);
  lines = [];
  clock = Date.now();
});
afterEach(() => {
  spy.mockRestore();
  vi.restoreAllMocks();
});

const auth = (privateKey = PKCS1_PEM) =>
  appAuth({ appId: APP_ID, privateKey, now: () => clock, log: (l) => lines.push(l) });
const lookups = () => github.calls.filter((c) => c.endsWith('/installation')).length;
const mints = () => github.app!.mints;

describe('3: the app JWT', () => {
  it('is RS256, issued by the app, backdated a minute, under ten minutes, and verifies with the public key', async () => {
    const now = 1_790_000_000_000;
    const { jwt } = await appJwt(await importAppKey(PKCS8_PEM), APP_ID, now);
    expect(decodeProtectedHeader(jwt)).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(decodeJwt(jwt)).toEqual({ iss: APP_ID, iat: now / 1000 - 60, exp: now / 1000 + 540 });
    const verified = await jwtVerify(jwt, keys.publicKey, { currentDate: new Date(now) });
    expect(verified.payload.iss).toBe(APP_ID);
  });
});

describe('4: keys', () => {
  it('wraps a PKCS#1 key into exactly the PKCS#8 bytes WebCrypto exports', () => {
    expect(pkcs8FromPkcs1(pkcs1Of(pkcs8))).toEqual(pkcs8);
  });

  it('signs with the PKCS#1 key GitHub downloads and with PKCS#8, and with literal \\n in place of newlines', async () => {
    for (const key of [PKCS1_PEM, PKCS8_PEM, PKCS1_PEM.replace(/\n/g, '\\n')]) {
      expect(await auth(key).tokenFor('acme/sidecar', 'read')).toMatch(/^ghs_/);
    }
  });

  it('a malformed key gives no token and a log line without the key', async () => {
    const broken = PKCS1_PEM.replace(KEY_TEXT, KEY_TEXT.slice(0, 20));
    expect(await auth('not a key').tokenFor('acme/sidecar', 'read')).toBeNull();
    expect(await auth(broken).tokenFor('acme/sidecar', 'read')).toBeNull();
    expect(lines).toEqual([
      expect.stringMatching(/no read token for acme\/sidecar: AppKeyError: not a PEM RSA private key/),
      expect.stringMatching(/no read token for acme\/sidecar: AppKeyError: the private key could not be imported/),
    ]);
    expect(lines.join('\n')).not.toContain(KEY_TEXT.slice(0, 20));
    expect(mints()).toEqual([]);
  });

  it("#56: the admin page's installation check does not silence a broken key's log line", async () => {
    const a = auth('not a key');
    expect(await a.installed!('acme/sidecar')).toBeNull();
    expect(await a.tokenFor('acme/sidecar', 'read')).toBeNull();
    expect(lines).toEqual([expect.stringMatching(/AppKeyError: not a PEM RSA private key/)]);
  });

  it('a broken key is imported once and logged once', async () => {
    const importKey = vi.spyOn(crypto.subtle, 'importKey');
    const a = auth('not a key');
    for (const purpose of ['read', 'write', 'read'] as const)
      expect(await a.tokenFor('acme/sidecar', purpose)).toBeNull();
    expect(lines).toHaveLength(1);
    const broken = auth(PKCS1_PEM.replace(KEY_TEXT, KEY_TEXT.slice(0, 20)));
    await broken.tokenFor('acme/sidecar', 'read');
    await broken.tokenFor('acme/globex', 'read');
    expect(importKey).toHaveBeenCalledTimes(1);
    expect(lines).toHaveLength(2);
  });
});

describe('3a: JWT reuse', () => {
  it('reuses the app JWT while it has over a minute left, then signs a new one', async () => {
    const a = auth();
    await a.tokenFor('acme/sidecar', 'read');
    clock += 7 * 60_000;
    await a.tokenFor('acme/sidecar', 'write');
    // 30 s left: under the minute's margin.
    clock += 90_000;
    await a.tokenFor('acme/globex', 'read');
    const iats = mints().map((m) => m.iat!);
    expect(iats[1]).toBe(iats[0]);
    expect(iats[2]).toBe(iats[0] + 510);
  });
});

describe('5 and 2a: installation and token per repo and purpose', () => {
  it('two repos of one owner get their own lookup and a token minted for that repo, with Issues read or write', async () => {
    const a = auth();
    const sidecarRead = await a.tokenFor('acme/sidecar', 'read');
    const globexRead = await a.tokenFor('acme/globex', 'read');
    const sidecarWrite = await a.tokenFor('acme/sidecar', 'write');
    expect(lookups()).toBe(2);
    expect(mints().map((m) => m.body)).toEqual([
      { repositories: ['sidecar'], permissions: { issues: 'read' } },
      { repositories: ['globex'], permissions: { issues: 'read' } },
      { repositories: ['sidecar'], permissions: { issues: 'write' } },
    ]);
    expect(new Set([sidecarRead, globexRead, sidecarWrite]).size).toBe(3);
  });

  it('5a: installed on one of two sibling repos, the other gets no token and the token does not reach it', async () => {
    github.app!.installations.delete('acme/globex');
    const a = auth();
    expect(await a.tokenFor('acme/globex', 'read')).toBeNull();
    expect(lines).toEqual(['github app: not installed on acme/globex']);
    const token = await a.tokenFor('acme/sidecar', 'read');
    const res = await fetch('https://api.github.com/repos/acme/globex/issues/52', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });
});

describe('6: not installed', () => {
  it('is asked again only after a minute', async () => {
    github.app!.installations.delete('acme/sidecar');
    const a = auth();
    expect(await a.tokenFor('acme/sidecar', 'read')).toBeNull();
    expect(await a.tokenFor('acme/sidecar', 'read')).toBeNull();
    expect(lookups()).toBe(1);
    github.app!.installations.set('acme/sidecar', 7);
    clock += 61_000;
    expect(await a.tokenFor('acme/sidecar', 'read')).toMatch(/^ghs_/);
    expect(lookups()).toBe(2);
  });
});

describe('7, 8 and 9: token reuse', () => {
  it('7: a second ask within the token life calls nothing', async () => {
    const a = auth();
    const first = await a.tokenFor('acme/sidecar', 'read');
    const before = github.calls.length;
    expect(await a.tokenFor('acme/sidecar', 'read')).toBe(first);
    expect(github.calls.length).toBe(before);
  });

  it('8: under five minutes left, a new token is minted; the installation is not looked up again', async () => {
    const a = auth();
    const first = await a.tokenFor('acme/sidecar', 'read');
    clock += 56 * 60_000;
    const second = await a.tokenFor('acme/sidecar', 'read');
    expect(second).not.toBe(first);
    expect(mints()).toHaveLength(2);
    expect(lookups()).toBe(1);
  });

  it('9: concurrent first asks make one lookup and one mint', async () => {
    const a = auth();
    const tokens = await Promise.all([1, 2, 3].map(() => a.tokenFor('acme/sidecar', 'write')));
    expect(new Set(tokens).size).toBe(1);
    expect(lookups()).toBe(1);
    expect(mints()).toHaveLength(1);
  });
});

describe('10 and 11: GitHub refusing or failing', () => {
  it('10: a 401 on the mint or the lookup starts over once; two 401s give no token', async () => {
    github.app!.failMints = [401];
    expect(await auth().tokenFor('acme/sidecar', 'read')).toMatch(/^ghs_/);
    expect(mints()).toHaveLength(2);
    github.app!.failLookups = [401];
    expect(await auth().tokenFor('acme/sidecar', 'read')).toMatch(/^ghs_/);
    github.app!.failMints = [401, 401];
    expect(await auth().tokenFor('acme/sidecar', 'read')).toBeNull();
    expect(lines.at(-1)).toBe('github app: no read token for acme/sidecar: GitHub refused the app twice');
  });

  it('11: a 5xx or a network error gives no token, caches nothing, and the next ask tries again', async () => {
    const a = auth();
    github.app!.failMints = [502];
    expect(await a.tokenFor('acme/sidecar', 'read')).toBeNull();
    spy.mockImplementationOnce(() => Promise.reject(new TypeError('network down')));
    expect(await a.tokenFor('acme/sidecar', 'read')).toBeNull();
    expect(lines).toEqual([
      expect.stringMatching(/token for acme\/sidecar -> 502/),
      expect.stringMatching(/TypeError: network down/),
    ]);
    expect(await a.tokenFor('acme/sidecar', 'read')).toMatch(/^ghs_/);
  });
});

describe('the hub with the app configured', () => {
  const app = { GITHUB_APP_ID: APP_ID, GITHUB_APP_PRIVATE_KEY: PKCS1_PEM };
  type Ticket = { number: number; title?: string; unavailable?: true };
  const tickets = async (envOverride: Record<string, string | undefined> = app) =>
    (await call(`/api/tickets?page=${encodeURIComponent(PAGE)}`, { email: 'dev@acme.dev', envOverride }))
      .body as unknown as Ticket[];
  const issueCalls = () => github.calls.filter((c) => c.includes('/issues/')).length;

  it('2: reads tickets and writes labels with installation tokens; the personal tokens are never sent', async () => {
    expect((await tickets()).map((t) => t.title)).toEqual(['Company approval', 'Join links']);
    const r = await call('/api/status', {
      email: 'dev@acme.dev',
      envOverride: app,
      body: { page: PAGE, status: 'in_review', expectedVersion: 0, hash: LIVE_HASH },
    });
    expect(r.body).toMatchObject({ labels: 'updated' });
    expect(github.issues.get(52)!.labels.filter((l) => l.startsWith('docs:'))).toHaveLength(1);
    expect(mints().map((m) => m.body)).toEqual([
      { repositories: ['sidecar'], permissions: { issues: 'read' } },
      { repositories: ['sidecar'], permissions: { issues: 'write' } },
    ]);
  });

  it('10a: a cached token GitHub rejects is replaced and the call retried once; a second 401 is the answer', async () => {
    const { env } = await import('cloudflare:workers');
    await tickets();
    await env.DB.prepare('DELETE FROM ticket_cache').run();
    github.app!.issued.clear();
    const before = issueCalls();
    expect((await tickets()).map((t) => t.title)).toEqual(['Company approval', 'Join links']);
    expect(issueCalls() - before).toBe(3);
    await env.DB.prepare('DELETE FROM ticket_cache').run();
    github.answer = (_m, _r, path) => (path.startsWith('/issues/') ? new Response('no', { status: 401 }) : null);
    const after = github.calls.length;
    expect(await tickets()).toEqual([
      { number: 52, unavailable: true },
      { number: 23, unavailable: true },
    ]);
    expect(github.calls.slice(after).filter((c) => c.includes('/issues/'))).toHaveLength(4);
  });

  it("10b: a 401 with no new token to retry with keeps GitHub's message for the log", async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    // A token until GitHub rejects it, then none to retry with.
    let rejected = false;
    deps.github = {
      tokenFor: async () => (rejected ? null : 'some-token'),
      invalidate: () => {
        rejected = true;
      },
    };
    github.answer = () => Response.json({ message: 'Bad credentials' }, { status: 401 });
    await call('/api/status', {
      email: 'dev@acme.dev',
      body: { page: PAGE, status: 'in_review', expectedVersion: 0, hash: LIVE_HASH },
    });
    expect(errors.mock.calls.map((c) => c.join(' ')).join('\n')).toMatch(/-> 401 Bad credentials/);
  });

  it('14: only one app secret set gives no token, sends no personal token, and says which is missing', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await tickets({ GITHUB_APP_ID: APP_ID })).toEqual([
      { number: 52, unavailable: true },
      { number: 23, unavailable: true },
    ]);
    expect(issueCalls()).toBe(0);
    expect(errors.mock.calls.map((c) => c.join(' '))).toContain('github app: GITHUB_APP_PRIVATE_KEY is not set');
  });
});

describe('#57: personal tokens', () => {
  it('serve tickets and labels, never adding a site', async () => {
    const t = envTokens({ GITHUB_READ_TOKEN: 'r', GITHUB_WRITE_TOKEN: 'w' } as unknown as Parameters<
      typeof envTokens
    >[0]);
    expect(await t.tokenFor('acme/x', 'read')).toBe('r');
    expect(await t.tokenFor('acme/x', 'write')).toBe('w');
    expect(await t.tokenFor('acme/x', 'setup-product')).toBeNull();
    expect(await t.tokenFor('acme/x', 'setup-config')).toBeNull();
  });
});

describe('#63: listing the installation repos', () => {
  it('two asks at once share one listing', async () => {
    github.app!.installations.set('acme/newdocs', 7);
    const a = auth();
    const [x, y] = await Promise.all([a.repos!('acme'), a.repos!('acme')]);
    expect(x).toEqual(['globex', 'newdocs', 'sidecar']);
    expect(y).toEqual(x);
    expect(github.calls.filter((c) => c === 'GET /orgs/acme/installation')).toHaveLength(1);
  });

  it('a listing that never settles is not waited on after 30 seconds', async () => {
    github.app!.installations.set('acme/newdocs', 7);
    const a = auth();
    let hung = true;
    const real = spy.getMockImplementation()!;
    spy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(new Request(input, init).url);
      if (hung && url.pathname === '/orgs/acme/installation') {
        hung = false;
        return new Promise<Response>(() => {});
      }
      return real(input, init);
    });
    void a.repos!('acme');
    clock += 31_000;
    expect(await a.repos!('acme')).toEqual(['globex', 'newdocs', 'sidecar']);
    expect(github.calls.filter((c) => c === 'GET /orgs/acme/installation')).toHaveLength(1);
  });
});
