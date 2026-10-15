import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actionsToken, filesOf, hubOrigin, inert, publishBuild, PublishError } from './publish.js';

let out: string;
beforeEach(() => {
  out = mkdtempSync(path.join(tmpdir(), 'publish-'));
  for (const [file, text] of [
    ['site/manifest.json', '{}'],
    ['site/index.html', 'home'],
    ['site/assets/app.js', 'js'],
    [`history/${'a'.repeat(40)}/page.md`, 'old'],
  ]) {
    mkdirSync(path.dirname(path.join(out, file)), { recursive: true });
    writeFileSync(path.join(out, file), text);
  }
});
afterEach(() => rmSync(out, { recursive: true, force: true }));

const ENV = {
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.example/req?x=1',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runtime-secret',
};
type Call = { url: string; init: RequestInit };
// A stub for the Actions token endpoint and the hub, answering the hub with
// the given responses in order.
const stub = (hubAnswers: (() => Response | Promise<Response>)[]) => {
  const calls: Call[] = [];
  let tokens = 0;
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith('https://token.example/')) return Response.json({ value: `oidc-${++tokens}` });
    const next = hubAnswers.shift();
    if (!next) throw new Error('no more hub answers');
    return next();
  }) as typeof fetch;
  return { calls, fetchImpl };
};
const V1 = `${'c'.repeat(40)}-100-1-abcdef01`;
const ok = () => Response.json({ version: V1 });
const noWait = async () => {};

describe('15: the hub origin and the token', () => {
  it('takes an exact https origin, or http only for a local hub', () => {
    expect(hubOrigin('https://docs.example.com')).toBe('https://docs.example.com');
    expect(hubOrigin('https://docs.example.com/')).toBe('https://docs.example.com');
    expect(hubOrigin('http://127.0.0.1:8796')).toBe('http://127.0.0.1:8796');
    for (const bad of [
      'http://docs.example.com',
      'https://user:pw@docs.example.com',
      'https://docs.example.com/sidecar',
      'https://docs.example.com/?x=1',
      'https://docs.example.com/#x',
      'ftp://docs.example.com',
      'docs.example.com',
      '',
    ]) {
      expect(() => hubOrigin(bad), bad).toThrow(PublishError);
    }
  });

  it('asks the Actions runtime for a token with the hub origin as audience', async () => {
    const { calls, fetchImpl } = stub([]);
    expect(await actionsToken('https://docs.example.com', ENV, fetchImpl)).toBe('oidc-1');
    expect(calls[0].url).toBe('https://token.example/req?x=1&audience=https%3A%2F%2Fdocs.example.com');
    expect(new Headers(calls[0].init.headers).get('authorization')).toBe('bearer runtime-secret');
    expect(calls[0].init.redirect).toBe('error');
  });

  it('without id-token: write it says so', async () => {
    const { fetchImpl } = stub([]);
    await expect(actionsToken('https://h.example', {}, fetchImpl)).rejects.toThrow('id-token: write');
  });
});

describe('14: publishing', () => {
  it('collects every site and history file', () => {
    expect(filesOf(out).map((f) => f.name)).toEqual([
      'site/assets/app.js',
      'site/index.html',
      'site/manifest.json',
      `history/${'a'.repeat(40)}/page.md`,
    ]);
  });

  it('sends one multipart request with every file and the token, refusing redirects', async () => {
    const { calls, fetchImpl } = stub([ok]);
    expect(
      await publishBuild({ hub: 'https://docs.example.com', repo: 'sidecar', out, env: ENV, fetch: fetchImpl }),
    ).toEqual({ version: V1 });
    const post = calls.find((c) => c.url === 'https://docs.example.com/_publish/sidecar')!;
    expect(post.init.method).toBe('POST');
    expect(post.init.redirect).toBe('error');
    expect(new Headers(post.init.headers).get('authorization')).toBe('Bearer oidc-1');
    const form = post.init.body as FormData;
    expect([...form.keys()]).toEqual(filesOf(out).map((f) => f.name));
  });

  it('retries a 5xx or a network error with a fresh token each time, then succeeds', async () => {
    const { calls, fetchImpl } = stub([
      () => Response.json({ error: { code: 'STORAGE_UNAVAILABLE' } }, { status: 503 }),
      () => Promise.reject(new Error('socket hang up')),
      ok,
    ]);
    expect(
      await publishBuild({ hub: 'https://h.example', repo: 'sidecar', out, env: ENV, fetch: fetchImpl, wait: noWait }),
    ).toEqual({ version: V1 });
    const tokensUsed = calls
      .filter((c) => c.url.includes('/_publish/'))
      .map((c) => new Headers(c.init.headers).get('authorization'));
    expect(tokensUsed).toEqual(['Bearer oidc-1', 'Bearer oidc-2', 'Bearer oidc-3']);
  });

  it('retries a failing token endpoint too', async () => {
    let tokenCalls = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith('https://token.example/')) {
        tokenCalls++;
        if (tokenCalls === 1) return new Response('busy', { status: 503 });
        if (tokenCalls === 2) throw new Error('ECONNRESET');
        return Response.json({ value: 'oidc-ok' });
      }
      return ok();
    }) as typeof fetch;
    expect(
      await publishBuild({ hub: 'https://h.example', repo: 'sidecar', out, env: ENV, fetch: fetchImpl, wait: noWait }),
    ).toEqual({ version: V1 });
    expect(tokenCalls).toBe(3);
  });

  it('stops on a 4xx, failing with the hub code and never the token', async () => {
    const { calls, fetchImpl } = stub([
      () => Response.json({ error: { code: 'INVALID_BUNDLE', message: 'page.html is missing' } }, { status: 422 }),
    ]);
    const err = await publishBuild({
      hub: 'https://h.example',
      repo: 'sidecar',
      out,
      env: ENV,
      fetch: fetchImpl,
      wait: noWait,
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(PublishError);
    expect((err as Error).message).toContain('422 INVALID_BUNDLE page.html is missing');
    expect((err as Error).message).not.toMatch(/oidc-|runtime-secret/);
    expect(calls.filter((c) => c.url.includes('/_publish/'))).toHaveLength(1);
  });

  it('retries BUSY, when another publish kept moving the pointer', async () => {
    const { fetchImpl } = stub([() => Response.json({ error: { code: 'BUSY' } }, { status: 409 }), ok]);
    expect(
      await publishBuild({ hub: 'https://h.example', repo: 'sidecar', out, env: ENV, fetch: fetchImpl, wait: noWait }),
    ).toEqual({ version: V1 });
  });

  it('gives up after three failures, naming the last', async () => {
    const down = () => Response.json({ error: { code: 'STORAGE_UNAVAILABLE' } }, { status: 503 });
    const { fetchImpl } = stub([down, down, down]);
    await expect(
      publishBuild({ hub: 'https://h.example', repo: 'sidecar', out, env: ENV, fetch: fetchImpl, wait: noWait }),
    ).rejects.toThrow('503 STORAGE_UNAVAILABLE');
  });

  it("a version not of the hub's shape is refused, so nothing odd reaches GITHUB_OUTPUT", async () => {
    const { fetchImpl } = stub([() => Response.json({ version: 'v1\nversion=other' })]);
    await expect(
      publishBuild({ hub: 'https://h.example', repo: 'sidecar', out, env: ENV, fetch: fetchImpl }),
    ).rejects.toThrow('malformed version');
  });

  it('a later run already published: done, not an error', async () => {
    const { fetchImpl } = stub([() => Response.json({ error: { code: 'SUPERSEDED' } }, { status: 409 })]);
    expect(await publishBuild({ hub: 'https://h.example', repo: 'sidecar', out, env: ENV, fetch: fetchImpl })).toEqual({
      superseded: true,
    });
  });

  it('refuses a bad repo name or a missing build before asking for a token', async () => {
    const { calls, fetchImpl } = stub([]);
    await expect(
      publishBuild({ hub: 'https://h.example', repo: 'Acme/Sidecar', out, env: ENV, fetch: fetchImpl }),
    ).rejects.toThrow('repo must be');
    rmSync(path.join(out, 'site', 'manifest.json'));
    await expect(
      publishBuild({ hub: 'https://h.example', repo: 'sidecar', out, env: ENV, fetch: fetchImpl }),
    ).rejects.toThrow('run the build first');
    expect(calls).toEqual([]);
  });
});

describe('#79: text from the hub or the network cannot start a workflow command', () => {
  const failWith = async (answer: () => Response | Promise<Response>) => {
    const { fetchImpl } = stub([answer, answer, answer]);
    const err = await publishBuild({
      hub: 'https://h.example',
      repo: 'sidecar',
      out,
      env: ENV,
      fetch: fetchImpl,
      wait: noWait,
    }).catch((e: Error) => e);
    return (err as Error).message;
  };
  const isInert = (line: string) => {
    expect(line).not.toMatch(/[\r\n\u2028\u2029]/);
    expect(line).not.toContain('::');
    expect(line).not.toContain('##[');
  };

  it('4: a hub message and code with line breaks and ::', async () => {
    const line = await failWith(() =>
      Response.json(
        { error: { code: 'X\n::add-mask::y', message: 'bad\r\n::error file=a::owned\n::stop-commands::t' } },
        { status: 422 },
      ),
    );
    isInert(line);
    expect(line).toContain('422 X : :add-mask: :y bad : :error file=a: :owned : :stop-commands: :t');
  });

  it('4a: the older ##[ form, runs of colons, and %0A are broken up or harmless', async () => {
    const line = await failWith(() =>
      Response.json(
        { error: { code: 'C', message: 'a ##[error]x ###[stop-commands]t ::: b%0A::warning::w' } },
        { status: 422 },
      ),
    );
    isInert(line);
    expect(line).not.toContain('##');
    expect(line).toContain('a # #[error]x # # #[stop-commands]t : : : b%0A: :warning: :w');
  });

  it('5: a network error and a failing token endpoint', async () => {
    const network = await failWith(() => {
      throw new TypeError('down\n::warning::x');
    });
    isInert(network);
    expect(network).toContain('network error: down : :warning: :x');
    let calls = 0;
    const tokenDown = (async (input: string | URL | Request) => {
      calls++;
      if (String(input).startsWith('https://token.example/')) throw new TypeError('no\u2028::debug::x');
      throw new Error('unreachable');
    }) as typeof fetch;
    const err = await publishBuild({
      hub: 'https://h.example',
      repo: 'sidecar',
      out,
      env: ENV,
      fetch: tokenDown,
      wait: noWait,
    }).catch((e: Error) => e);
    isInert((err as Error).message);
    expect(calls).toBe(3);
  });

  it('6: a long message is cut to 300 characters', async () => {
    const line = await failWith(() =>
      Response.json({ error: { code: 'C', message: 'm'.repeat(400) } }, { status: 422 }),
    );
    expect(line).toContain(`422 C ${'m'.repeat(298)}`);
    expect(line).not.toContain('m'.repeat(299));
    expect(inert('a'.repeat(400))).toHaveLength(300);
    // A character outside the basic plane is never cut in half.
    expect(inert(`${'a'.repeat(299)}\u{1F600}b`)).toBe(`${'a'.repeat(299)}\u{1F600}`);
  });
});
