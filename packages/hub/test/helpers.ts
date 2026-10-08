import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { vi } from 'vitest';
import type { Manifest } from '@specreview/shared';
import type { Deps } from '../src/ctx';
import type { Env } from '../src/env';
import { configOf } from '../src/config';
import { reconcileLabels } from '../src/github';
import { envTokens } from '../src/github-auth';
import { createHub } from '../src/index';
import { forgetLabelSetup } from '../src/github';
import { forgetManifests } from '../src/manifest';
import { memoryStore, type SiteStore } from '../src/store';

export const TEAM = 'test.cloudflareaccess.com';
export const HOST = 'https://docs.example.com';
export const PAGE = 'onboarding/signup';
export const LIVE_HASH = 'hash-live';
export const COMMIT_OLD = 'a'.repeat(40);
export const COMMIT_LIVE = 'b'.repeat(40);

// One org's hub with three sites. sidecar and web share a team and a ticket
// repo; globex has its own team and ticket repo. Readers at initech.example
// may read every site.
export const ORG = 'acme';
export const SIDECAR = 'sidecar';
export const WEB = 'web';
export const GLOBEX = 'globex';
export const keyOf = (repo: string) => `${ORG}/${repo}`;
export const HUB_AUD = 'aud-hub';
export const VERSION = `${'b'.repeat(40)}-1`;

export const CONFIG = {
  org: ORG,
  accessTeamDomain: TEAM,
  accessAud: HUB_AUD,
  admins: ['owner@acme.dev'],
  sites: [
    {
      repo: SIDECAR,
      teamDomains: ['acme.dev'],
      approvers: ['approver@acme.dev'],
      readers: ['@initech.example'],
      ticketRepo: SIDECAR,
    },
    {
      repo: WEB,
      teamDomains: ['acme.dev'],
      approvers: ['webpm@acme.dev'],
      readers: ['@initech.example'],
      ticketRepo: SIDECAR,
    },
    {
      repo: GLOBEX,
      teamDomains: ['globex.dev'],
      approvers: ['pm@globex.dev'],
      readers: ['@initech.example'],
      ticketRepo: GLOBEX,
    },
  ],
};

const signupPage = (hash: string, issues: number[]) => ({
  title: 'Company signup',
  hash,
  issues,
  sections: [
    {
      id: 'who-can-sign-up',
      title: 'Who can sign up',
      text: 'Anyone with a work email can create a company. A new company waits for approval.',
    },
    {
      id: 'limits',
      title: 'Limits',
      text: 'One account can own up to 3 companies, including ones waiting for approval.',
    },
  ],
  history: [
    {
      commit: COMMIT_LIVE,
      date: '2026-10-07T00:00:00.000Z',
      author: 'Manish Jadhav',
      pr: 60,
      path: `${PAGE}.md`,
      hash,
    },
    {
      commit: COMMIT_OLD,
      date: '2026-10-03T00:00:00.000Z',
      author: 'Manish Jadhav',
      pr: 51,
      path: `${PAGE}.md`,
      hash: 'hash-old',
    },
  ],
});

export const manifests = (webIssues: number[] = []): Record<string, Manifest> => ({
  [SIDECAR]: {
    commit: COMMIT_LIVE,
    builtAt: '2026-10-07T00:00:00.000Z',
    pages: {
      [PAGE]: signupPage(LIVE_HASH, [52, 23]),
      'onboarding/approval': {
        title: 'Company approval',
        hash: 'hash-approval',
        issues: [52],
        sections: [{ id: 'why', title: 'Why', text: 'Every new company waits until an Acme admin approves it.' }],
        history: [],
      },
      index: { title: 'sidecar docs', hash: 'hash-index', issues: [], sections: [], history: [] },
    },
  },
  // The same page key on another site of the same team and ticket repo.
  [WEB]: {
    commit: COMMIT_LIVE,
    builtAt: '2026-10-07T00:00:00.000Z',
    pages: { [PAGE]: signupPage('hash-web', webIssues) },
  },
  [GLOBEX]: {
    commit: COMMIT_LIVE,
    builtAt: '2026-10-07T00:00:00.000Z',
    pages: { [PAGE]: signupPage('hash-globex', [52]) },
  },
});

export const historyFiles = (): Record<string, string> => ({
  [`${SIDECAR}/history/${COMMIT_OLD}/${PAGE}.md`]: '# Company signup\n\nAnyone with the join link can join.\n',
  [`${GLOBEX}/history/${COMMIT_OLD}/${PAGE}.md`]: '# Globex signup\n\nGlobex only.\n',
});

// Every site published at VERSION: pointer, manifest, pages and history.
export const publishedFiles = (all: Record<string, Manifest> = manifests(), version = VERSION): Map<string, string> => {
  const files = new Map<string, string>(Object.entries(historyFiles()));
  for (const [repo, manifest] of Object.entries(all)) {
    files.set(`${repo}/current.json`, JSON.stringify({ version, publishedAt: '2026-10-08T00:00:00.000Z' }));
    files.set(`${repo}/v/${version}/manifest.json`, JSON.stringify(manifest));
    files.set(`${repo}/v/${version}/index.html`, `<!doctype html><title>${repo} home</title>`);
    files.set(`${repo}/v/${version}/${PAGE}.html`, `<!doctype html><title>${repo} signup</title>`);
  }
  return files;
};

// The store and GitHub access the hub under test uses; tests may replace them.
export const deps: { store: SiteStore; github: Deps['github'] | null } = {
  store: memoryStore(new Map()),
  github: null,
};
const hub = createHub((e) => ({ store: deps.store, github: deps.github ?? envTokens(e) }));

export const testEnv = (override: Partial<Env> = {}): Env => ({
  ...env,
  SPECREVIEW_CONFIG: JSON.stringify(CONFIG),
  GITHUB_READ_TOKEN: 'test-read',
  GITHUB_WRITE_TOKEN: 'test-write',
  ...override,
});

const signing = await generateKeyPair('RS256', { extractable: true });
export const strangerKey = await generateKeyPair('RS256', { extractable: true });
const publicJwk = { ...(await exportJWK(signing.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };

type Claims = {
  email?: unknown;
  aud?: string;
  iss?: string;
  kid?: string;
  key?: CryptoKey;
  expiresIn?: string;
  notBefore?: string;
  alg?: string;
};

export const token = async (claims: Claims = {}) => {
  const payload: Record<string, unknown> = 'email' in claims ? { email: claims.email } : {};
  const jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: claims.alg ?? 'RS256', kid: claims.kid ?? 'k1' })
    .setIssuer(claims.iss ?? `https://${TEAM}`)
    .setAudience(claims.aud ?? HUB_AUD)
    .setIssuedAt()
    .setExpirationTime(claims.expiresIn ?? '5m');
  if (claims.notBefore) jwt.setNotBefore(claims.notBefore);
  return jwt.sign(claims.key ?? signing.privateKey);
};

export const tokenFor = (email: string) => token({ email, aud: HUB_AUD });

// A stand-in for GitHub's issues API: labels per issue, per repo.
type StubIssue = { title: string; state: string; labels: string[] };
const freshRepos = () =>
  new Map<string, Map<number, StubIssue>>([
    [
      'acme/sidecar',
      new Map([
        [52, { title: 'Company approval', state: 'open', labels: ['enhancement'] }],
        [23, { title: 'Join links', state: 'open', labels: [] }],
      ]),
    ],
    ['acme/globex', new Map([[52, { title: 'Globex queue', state: 'open', labels: [] }]])],
  ]);
export const github = {
  repos: freshRepos(),
  // The default site's ticket repo, as most tests use it.
  get issues() {
    return this.repos.get('acme/sidecar')!;
  },
  calls: [] as string[],
  // Label definitions per repo; repos start with ours missing.
  labelDefs: new Map<string, Set<string>>(),
  // Fail only the label-definition endpoints: 'down' answers 503, 'invalid' a
  // 422 validation error on create.
  labelsMode: 'ok' as 'ok' | 'down' | 'invalid',
  down: false,
  downRepos: new Set<string>(),
  failWritesFor: new Set<number>(),
  reset() {
    this.repos = freshRepos();
    this.calls = [];
    this.labelDefs = new Map();
    this.labelsMode = 'ok';
    this.down = false;
    this.downRepos = new Set();
    this.failWritesFor = new Set();
  },
};

const githubResponse = async (req: Request, url: URL): Promise<Response> => {
  github.calls.push(`${req.method} ${url.pathname}${url.search}`);
  const def = /^\/repos\/([^/]+\/[^/]+)\/labels(?:\/(.+))?$/.exec(url.pathname);
  if (def) {
    if (github.down || github.downRepos.has(def[1]) || github.labelsMode === 'down') {
      return new Response('unavailable', { status: 503 });
    }
    const defs = github.labelDefs.get(def[1]) ?? new Set<string>();
    github.labelDefs.set(def[1], defs);
    if (req.method === 'GET' && def[2]) {
      return defs.has(decodeURIComponent(def[2]))
        ? Response.json({ name: decodeURIComponent(def[2]) })
        : Response.json({}, { status: 404 });
    }
    if (req.method === 'POST' && !def[2]) {
      const { name } = (await req.json()) as { name: string };
      if (github.labelsMode === 'invalid') return Response.json({ errors: [{ code: 'invalid' }] }, { status: 422 });
      if (defs.has(name)) return Response.json({ errors: [{ code: 'already_exists' }] }, { status: 422 });
      defs.add(name);
      return Response.json({ name }, { status: 201 });
    }
    return new Response('not found', { status: 404 });
  }
  const m = /^\/repos\/([^/]+\/[^/]+)\/issues(?:\/(\d+)(\/labels(?:\/(.+))?)?)?$/.exec(url.pathname);
  if (!m) return new Response('not found', { status: 404 });
  const repo = m[1];
  if (github.down || github.downRepos.has(repo)) return new Response('unavailable', { status: 503 });
  const issues = github.repos.get(repo);
  if (!issues) return Response.json({ message: 'Not Found' }, { status: 404 });
  if (!m[2] && req.method === 'GET') {
    const label = url.searchParams.get('labels');
    const page = Number(url.searchParams.get('page') ?? '1');
    const per = Number(url.searchParams.get('per_page') ?? '30');
    const hits = [...issues.entries()]
      .filter(([, i]) => label !== null && i.labels.includes(label))
      .slice((page - 1) * per, page * per);
    return Response.json(
      hits.map(([number, i]) => ({
        number,
        title: i.title,
        state: i.state,
        html_url: '',
        labels: i.labels.map((name) => ({ name })),
      })),
    );
  }
  const n = Number(m[2]);
  const issue = issues.get(n);
  if (!issue) return Response.json({ message: 'Not Found' }, { status: 404 });
  if (req.method !== 'GET' && github.failWritesFor.has(n)) return new Response('boom', { status: 500 });
  if (req.method === 'POST' && m[3]) {
    const { labels } = (await req.json()) as { labels: string[] };
    for (const l of labels) if (!issue.labels.includes(l)) issue.labels.push(l);
    return Response.json(issue.labels.map((name) => ({ name })));
  }
  if (req.method === 'DELETE' && m[4]) {
    const name = decodeURIComponent(m[4]);
    if (!issue.labels.includes(name)) return Response.json({ message: 'Label does not exist' }, { status: 404 });
    issue.labels = issue.labels.filter((l) => l !== name);
    return Response.json(issue.labels.map((x) => ({ name: x })));
  }
  return Response.json({
    number: n,
    title: issue.title,
    state: issue.state,
    html_url: `https://github.com/${repo}/issues/${n}`,
    labels: issue.labels.map((name) => ({ name })),
  });
};

export const certs = { down: false, served: 0 };

export const installFetch = () =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.host === TEAM && url.pathname === '/cdn-cgi/access/certs') {
      certs.served++;
      if (certs.down) return new Response('down', { status: 503 });
      return Response.json({ keys: [publicJwk] });
    }
    if (url.host === 'api.github.com') return githubResponse(req, url);
    throw new Error(`unexpected outbound fetch: ${req.url}`);
  });

// Fresh state for each test: tables, GitHub stub, store and manifest cache.
export const reset = async () => {
  github.reset();
  deps.store = memoryStore(publishedFiles());
  deps.github = null;
  forgetManifests();
  forgetLabelSetup();
  await env.DB.batch(
    ['replies', 'threads', 'status_history', 'page_status', 'ticket_cache', 'write_log'].map((t) =>
      env.DB.prepare(`DELETE FROM ${t}`),
    ),
  );
};

type CallOptions = {
  site?: string;
  email?: string;
  token?: string | null;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
  method?: string;
  envOverride?: Partial<Env>;
  // Send the path exactly as given, without mapping /api or /_history onto a site.
  raw?: boolean;
};

// '/api/x' and '/_history/x' are site-relative; anything else is sent as is.
const pathFor = (path: string, site: string) => {
  if (path.startsWith('/api/')) return `/${site}/_api/${path.slice(5)}`;
  if (path.startsWith('/_history/')) return `/${site}${path}`;
  return path;
};

export const call = async (path: string, opts: CallOptions = {}) => {
  const site = opts.site ?? SIDECAR;
  const headers = new Headers(opts.headers ?? {});
  const jwt = opts.token !== undefined ? opts.token : opts.email ? await tokenFor(opts.email) : null;
  if (jwt) headers.set('cf-access-jwt-assertion', jwt);
  const hasBody = opts.body !== undefined || opts.rawBody !== undefined;
  if (hasBody && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (hasBody && !headers.has('origin')) headers.set('origin', HOST);
  const request = new Request(`${HOST}${opts.raw ? path : pathFor(path, site)}`, {
    method: opts.method ?? (hasBody ? 'POST' : 'GET'),
    headers,
    body: opts.rawBody ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });
  const ctx = createExecutionContext();
  const res = await hub.fetch(request, testEnv(opts.envOverride), ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  const parsed = res.headers.get('content-type')?.includes('json') ? (JSON.parse(text) as unknown) : text;
  return { status: res.status, headers: res.headers, body: parsed as Record<string, unknown> & unknown[] };
};

export const runCron = async (override: Partial<Env> = {}) => {
  const ctx = createExecutionContext();
  hub.scheduled(createScheduledController(), testEnv(override), ctx);
  await waitOnExecutionContext(ctx);
};

// The label reconciler on its own, with the hub's context, to read its result.
export const reconcile = () => {
  const e = testEnv();
  return reconcileLabels({
    env: e,
    deps: { store: deps.store, github: deps.github ?? envTokens(e) },
    config: configOf(e.SPECREVIEW_CONFIG),
  });
};

export const errorCode = (r: { body: unknown }) => (r.body as { error?: { code?: string } }).error?.code;

export const comment = (email: string, overrides: Record<string, unknown> = {}, site = SIDECAR) =>
  call('/api/comments', {
    site,
    email,
    body: {
      page: PAGE,
      heading: 'limits',
      quote: 'including ones waiting for approval',
      body: 'Does a rejected company free up one of the 3?',
      ...overrides,
    },
  });
