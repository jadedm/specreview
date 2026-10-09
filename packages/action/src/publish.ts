// The publish job's only code: send one build to the hub with a GitHub
// Actions OIDC token. It runs with id-token: write, so it executes nothing
// from the product repo and never prints or passes the token anywhere.
import { existsSync, openAsBlob, readdirSync } from 'node:fs';
import path from 'node:path';

export class PublishError extends Error {}

// The hub as an exact origin: https (http only for a local hub), no
// credentials, path, query or fragment, so the token goes to that host only.
export const hubOrigin = (hub: string): string => {
  const url = (() => {
    try {
      return new URL(hub);
    } catch {
      return null;
    }
  })();
  const local = url !== null && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  const ok =
    url !== null &&
    (url.protocol === 'https:' || local) &&
    url.username === '' &&
    url.password === '' &&
    (url.pathname === '/' || url.pathname === '') &&
    url.search === '' &&
    url.hash === '';
  if (!ok)
    throw new PublishError(`hub must be an https origin such as https://docs.example.com, got ${JSON.stringify(hub)}`);
  return url.origin;
};

const REPO = /^[a-z0-9._-]{1,100}$/;
const VERSION = /^[0-9a-f]{40}-[0-9]{1,20}-[0-9]{1,6}-[0-9a-f]{8}$/;

type Env = Record<string, string | undefined>;
type Fetch = typeof fetch;

// A fresh token from the Actions runtime for the hub's origin. Each attempt
// gets its own: the hub accepts a token once.
export const actionsToken = async (audience: string, env: Env, fetchImpl: Fetch): Promise<string> => {
  const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !bearer) {
    throw new PublishError('no OIDC token available: the publish job needs `permissions: id-token: write`');
  }
  const res = await fetchImpl(`${url}&audience=${encodeURIComponent(audience)}`, {
    headers: { authorization: `bearer ${bearer}` },
    redirect: 'error',
  });
  const body = (await res.json().catch(() => null)) as { value?: unknown } | null;
  if (!res.ok || typeof body?.value !== 'string')
    throw new PublishError(`the OIDC token request failed (${res.status})`);
  return body.value;
};

// Every file of the build output: site/<path> and history/<commit>/<path>.
export const filesOf = (out: string): { name: string; file: string }[] =>
  ['site', 'history'].flatMap((top) => {
    const dir = path.join(out, top);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => {
        const file = path.join(d.parentPath, d.name);
        return { name: `${top}/${path.relative(dir, file).split(path.sep).join('/')}`, file };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  });

export type PublishResult = { version: string } | { superseded: true };
type Options = {
  hub: string;
  repo: string;
  out: string;
  env: Env;
  fetch?: Fetch;
  wait?: (ms: number) => Promise<void>;
};

const ATTEMPTS = 3;

export const publishBuild = async ({
  hub,
  repo,
  out,
  env,
  fetch: fetchImpl = fetch,
  wait,
}: Options): Promise<PublishResult> => {
  const origin = hubOrigin(hub);
  if (!REPO.test(repo))
    throw new PublishError(`repo must be the repository's lowercase name, got ${JSON.stringify(repo)}`);
  const files = filesOf(out);
  if (!files.some((f) => f.name === 'site/manifest.json'))
    throw new PublishError(`${out}/site/manifest.json is missing: run the build first`);
  const pause = wait ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let last = '';
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const form = new FormData();
    for (const f of files) form.append(f.name, await openAsBlob(f.file), path.basename(f.file));
    // The token endpoint can fail transiently too; that is retried like the
    // hub. A missing permission is not.
    const token = await actionsToken(origin, env, fetchImpl).catch((e: unknown) => {
      if (e instanceof PublishError && e.message.includes('id-token: write')) throw e;
      last = e instanceof Error ? e.message : String(e);
      return null;
    });
    if (token === null) {
      if (attempt === ATTEMPTS) break;
      await pause(2000 * attempt);
      continue;
    }
    const res = await fetchImpl(`${origin}/_publish/${repo}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form,
      redirect: 'error',
    }).catch((e: unknown) => {
      last = `network error: ${e instanceof Error ? e.message : String(e)}`;
      return null;
    });
    const body = res
      ? ((await res.json().catch(() => null)) as {
          version?: string;
          error?: { code?: string; message?: string };
        } | null)
      : null;
    if (res?.ok && typeof body?.version === 'string') {
      // Goes to GITHUB_OUTPUT: only a version of the hub's own shape.
      if (!VERSION.test(body.version)) throw new PublishError('the hub answered with a malformed version');
      return { version: body.version };
    }
    // A later run has already published: nothing to do.
    if (res?.status === 409 && body?.error?.code === 'SUPERSEDED') return { superseded: true };
    if (res) last = `${res.status} ${body?.error?.code ?? ''} ${body?.error?.message ?? ''}`.trim();
    // BUSY: another publish kept moving the pointer; a fresh attempt can win.
    const retryable = res === null || res.status >= 500 || (res.status === 409 && body?.error?.code === 'BUSY');
    if (!retryable || attempt === ATTEMPTS) break;
    await pause(2000 * attempt);
  }
  throw new PublishError(`publishing to ${origin} failed: ${last}`);
};
