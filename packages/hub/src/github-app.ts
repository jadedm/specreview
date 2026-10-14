import type { GitHubAuth, Purpose } from './github-auth';

// The hub as a GitHub App: an app JWT finds the installation on a ticket repo
// and mints an installation token for that repo alone, with Issues read or
// write by purpose. Caches live in this isolate only. Failures give no token
// ("unavailable" to callers) and one log line, never the key or a token.

const API = 'https://api.github.com';
const HEADERS = {
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'specreview',
};

// GitHub caps an app JWT at 10 minutes and checks iat against its own clock;
// backdating a minute covers a clock that runs ahead.
const JWT_BACKDATE_S = 60;
const JWT_LIFE_S = 540;
// Mint a new token when the cached one has less than this left.
const TOKEN_MARGIN_MS = 5 * 60_000;
const INSTALLATION_TTL_MS = 60 * 60_000;
// A repo the app is not installed on is asked again after a minute, so
// installing the app takes effect without a deploy.
const MISSING_TTL_MS = 60_000;

const PERMISSION: Record<Purpose, Record<string, string>> = {
  read: { issues: 'read' },
  write: { issues: 'write' },
  // Adding a site (#57): a workflow file and a pull request on the product
  // repo; a config change and a pull request on the config repo.
  'setup-product': { contents: 'write', pull_requests: 'write', workflows: 'write' },
  'setup-config': { contents: 'write', pull_requests: 'write' },
  // Listing a repo's branches for the add-site form (#63).
  browse: { contents: 'read' },
};

// Lists are read to the end, 100 a page; past this many pages the form asks
// for the name as text rather than show a list that is not whole (#63).
export const LIST_PAGES = 20;
const REPOS_TTL_MS = 60_000;

export class AppKeyError extends Error {
  override name = 'AppKeyError';
}

const b64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const b64urlJson = (value: unknown) => b64url(new TextEncoder().encode(JSON.stringify(value)));

const derLength = (n: number) => {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return [0x80 | bytes.length, ...bytes];
};
const der = (tag: number, body: Uint8Array) => new Uint8Array([tag, ...derLength(body.length), ...body]);

// PKCS#8 wraps a PKCS#1 RSA key as
// SEQUENCE { INTEGER 0, SEQUENCE { rsaEncryption, NULL }, OCTET STRING pkcs1 }.
const RSA_ALGORITHM = new Uint8Array([
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
]);
export const pkcs8FromPkcs1 = (pkcs1: Uint8Array) =>
  der(0x30, new Uint8Array([0x02, 0x01, 0x00, ...RSA_ALGORITHM, ...der(0x04, pkcs1)]));

const pemBody = (pem: string, label: string) => {
  const m = new RegExp(`-----BEGIN ${label}-----([A-Za-z0-9+/=\\s]+)-----END ${label}-----`).exec(pem);
  return m ? b64(m[1].replace(/\s+/g, '')) : null;
};

// GitHub downloads the key as PKCS#1 ("RSA PRIVATE KEY"); WebCrypto takes
// PKCS#8 only. workerd happens to accept PKCS#1 bytes as PKCS#8 too; the
// standard does not, so the key is wrapped either way. A key pasted with literal \n is accepted too.
export const importAppKey = async (pem: string): Promise<CryptoKey> => {
  const text = pem.replace(/\\n/g, '\n');
  const pkcs8 = pemBody(text, 'PRIVATE KEY');
  const pkcs1 = pkcs8 ? null : pemBody(text, 'RSA PRIVATE KEY');
  const bytes = pkcs8 ?? (pkcs1 && pkcs8FromPkcs1(pkcs1));
  if (!bytes) throw new AppKeyError('not a PEM RSA private key (PKCS#1 or PKCS#8)');
  return crypto.subtle
    .importKey('pkcs8', bytes, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
    .catch(() => {
      throw new AppKeyError('the private key could not be imported');
    });
};

export const appJwt = async (key: CryptoKey, appId: string, nowMs: number) => {
  const now = Math.floor(nowMs / 1000);
  const input = `${b64urlJson({ alg: 'RS256', typ: 'JWT' })}.${b64urlJson({
    iss: appId,
    iat: now - JWT_BACKDATE_S,
    exp: now + JWT_LIFE_S,
  })}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(input));
  return { jwt: `${input}.${b64url(new Uint8Array(sig))}`, expiresMs: (now + JWT_LIFE_S) * 1000 };
};

export type AppAuthOptions = {
  appId: string;
  privateKey: string;
  now?: () => number;
  log?: (line: string) => void;
};

type Installation = { id: number | null; until: number };
type Token = { token: string; expiresMs: number };

// Thrown inside a mint to start over once with fresh credentials.
class Retry extends Error {}

export const appAuth = ({
  appId,
  privateKey,
  now = Date.now,
  log = (line) => console.error(line),
}: AppAuthOptions): GitHubAuth => {
  // The key comes from a secret, so a broken one stays broken until a deploy
  // makes a new instance: imported once, its failure logged once.
  let key: Promise<CryptoKey> | null = null;
  let keyLogged = false;
  let jwt: { jwt: string; expiresMs: number } | null = null;
  const installations = new Map<string, Installation>();
  const tokens = new Map<string, Token>();
  const inflight = new Map<string, Promise<string | null>>();

  const signed = async () => {
    if (jwt && jwt.expiresMs - now() > 60_000) return jwt.jwt;
    key ??= importAppKey(privateKey);
    jwt = await appJwt(await key, appId, now());
    return jwt.jwt;
  };

  const app = async (path: string, init: RequestInit = {}) =>
    fetch(`${API}${path}`, {
      ...init,
      headers: {
        ...HEADERS,
        authorization: `Bearer ${await signed()}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      signal: AbortSignal.timeout(5_000),
    });

  const installationFor = async (repo: string) => {
    const known = installations.get(repo);
    if (known && known.until > now()) return known.id;
    const res = await app(`/repos/${repo}/installation`);
    if (res.status === 401) throw new Retry();
    if (res.status === 404) {
      installations.set(repo, { id: null, until: now() + MISSING_TTL_MS });
      log(`github app: not installed on ${repo}`);
      return null;
    }
    if (!res.ok) throw new Error(`installation lookup for ${repo} -> ${res.status}`);
    const { id } = (await res.json()) as { id?: unknown };
    if (typeof id !== 'number') throw new Error(`installation lookup for ${repo} -> ${res.status} with no id`);
    installations.set(repo, { id, until: now() + INSTALLATION_TTL_MS });
    return id;
  };

  const mint = async (repo: string, purpose: Purpose) => {
    const id = await installationFor(repo);
    if (id === null) return null;
    const res = await app(`/app/installations/${id}/access_tokens`, {
      method: 'POST',
      body: JSON.stringify({ repositories: [repo.split('/')[1]], permissions: PERMISSION[purpose] }),
    });
    if (res.status === 401 || res.status === 404) throw new Retry();
    if (!res.ok) throw new Error(`token for ${repo} -> ${res.status}`);
    const body = (await res.json()) as { token?: unknown; expires_at?: unknown };
    const expiresMs = typeof body.expires_at === 'string' ? Date.parse(body.expires_at) : NaN;
    if (typeof body.token !== 'string' || !Number.isFinite(expiresMs))
      throw new Error(`token for ${repo} -> ${res.status} with no token`);
    tokens.set(`${repo} ${purpose}`, { token: body.token, expiresMs });
    return body.token;
  };

  const fresh = async (repo: string, purpose: Purpose) => {
    try {
      return await mint(repo, purpose).catch((err: unknown) => {
        if (!(err instanceof Retry)) throw err;
        // A rejected JWT or a gone installation: start over once.
        jwt = null;
        installations.delete(repo);
        return mint(repo, purpose);
      });
    } catch (err) {
      if (err instanceof AppKeyError && keyLogged) return null;
      if (err instanceof AppKeyError) keyLogged = true;
      const why = err instanceof Retry ? 'GitHub refused the app twice' : errorText(err);
      log(`github app: no ${purpose} token for ${repo}: ${why}`);
      return null;
    }
  };

  // The installation's repos for the add-site form: a token for the whole
  // installation holding only Metadata read.
  // A failure is remembered briefly and one listing runs at a time, so a slow
  // or failing GitHub is not asked again on every page load.
  const repoLists = new Map<string, { names: string[] | 'too-many' | null; until: number }>();
  // A listing older than this is not waited on: the request that started it
  // may have answered and had its fetches cancelled, leaving it unsettled.
  const listing = new Map<string, { promise: Promise<string[] | 'too-many' | null>; started: number }>();
  const LISTING_STALE_MS = 30_000;
  const FAILED_TTL_MS = 30_000;
  const listRepos = async (owner: string): Promise<string[] | 'too-many'> => {
    const found = await app(`/orgs/${owner}/installation`);
    if (!found.ok) throw new Error(`installation lookup for ${owner} -> ${found.status}`);
    const { id } = (await found.json()) as { id: number };
    const minted = await app(`/app/installations/${id}/access_tokens`, {
      method: 'POST',
      body: JSON.stringify({ permissions: { metadata: 'read' } }),
    });
    if (!minted.ok) throw new Error(`token for ${owner} -> ${minted.status}`);
    const { token } = (await minted.json()) as { token: string };
    const names: string[] = [];
    for (let page = 1; page <= LIST_PAGES; page++) {
      const res = await fetch(`${API}/installation/repositories?per_page=100&page=${page}`, {
        headers: { ...HEADERS, authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) throw new Error(`listing repos for ${owner} -> ${res.status}`);
      const body = (await res.json()) as {
        repositories?: { name: string; archived?: boolean; owner?: { login?: string } }[];
      };
      const batch = body.repositories ?? [];
      for (const r of batch)
        if (!r.archived && r.owner?.login?.toLowerCase() === owner) names.push(r.name.toLowerCase());
      if (batch.length < 100) return names.sort();
    }
    return 'too-many';
  };

  return {
    hasApp: async () => true,
    repos: async (owner) => {
      const known = repoLists.get(owner);
      if (known && known.until > now()) return known.names;
      const running = listing.get(owner);
      if (running && now() - running.started < LISTING_STALE_MS) return running.promise;
      const started = listRepos(owner)
        .then((names) => {
          repoLists.set(owner, { names, until: now() + REPOS_TTL_MS });
          return names;
        })
        .catch((err: unknown) => {
          log(`github app: could not list repos for ${owner}: ${errorText(err)}`);
          repoLists.set(owner, { names: null, until: now() + FAILED_TTL_MS });
          return null;
        })
        .finally(() => {
          if (listing.get(owner)?.promise === started) listing.delete(owner);
        });
      listing.set(owner, { promise: started, started: now() });
      return started;
    },
    // For the admin page: whether the app is installed on the repo; null when
    // GitHub cannot be asked.
    installed: async (repo) => {
      try {
        return (await installationFor(repo)) !== null;
      } catch {
        // tokenFor logs a broken key; this answer only says it could not ask.
        return null;
      }
    },
    tokenFor: async (repo, purpose) => {
      const cacheKey = `${repo} ${purpose}`;
      const cached = tokens.get(cacheKey);
      if (cached && cached.expiresMs - now() > TOKEN_MARGIN_MS) return cached.token;
      const running = inflight.get(cacheKey);
      if (running) return running;
      const started = fresh(repo, purpose).finally(() => inflight.delete(cacheKey));
      inflight.set(cacheKey, started);
      return started;
    },
    invalidate: (repo, purpose) => {
      tokens.delete(`${repo} ${purpose}`);
    },
  };
};

const errorText = (err: unknown) =>
  err instanceof Error ? `${err.name}: ${err.message.replace(/\s+/g, ' ').slice(0, 200)}` : typeof err;
