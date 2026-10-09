// A stand-in for the parts of the Cloudflare API setup and secret use, with
// two items per page so every list exercises pagination. Like the real API,
// a new Access application takes only references to reusable policies.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const ACCOUNT = '0123456789abcdef0123456789abcdef';
export const TOKEN = 'cf-test-token-value';
const PAGE = 2;

type Policy = {
  id: string;
  name: string;
  decision: string;
  include: unknown[];
  exclude?: unknown[];
  require?: unknown[];
};
type App = {
  id: string;
  domain: string;
  type: string;
  aud: string;
  name: string;
  allowed_idps?: string[];
  policies: { id: string; precedence?: number }[];
};

export type FakeState = {
  accounts: string[];
  accessEnabled: boolean;
  authDomain: string;
  zones: { id: string; name: string; status: string }[];
  dns: Record<string, { name: string }[]>;
  workerDomains: { hostname: string; service: string }[];
  idps: { id: string; type: string }[];
  d1: { uuid: string; name: string }[];
  r2: { name: string }[];
  policies: Policy[];
  apps: App[];
  scripts: string[];
};

export const emptyAccount = (): FakeState => ({
  accounts: [ACCOUNT],
  accessEnabled: true,
  authDomain: 'acme.cloudflareaccess.com',
  zones: [{ id: 'z1', name: 'acme.dev', status: 'active' }],
  dns: { z1: [] },
  workerDomains: [],
  idps: [],
  d1: [],
  r2: [],
  policies: [],
  apps: [],
  scripts: [],
});

export type Request = { method: string; path: string; body?: unknown; auth: string | null };
export type FakeOptions = {
  failOn?: (r: Request) => boolean;
  raw?: (r: Request) => Response | null;
  // Lists that report no page count, as some Cloudflare lists do.
  noPageCount?: boolean;
};

export const fakeCloudflare = (state: FakeState, opts: FakeOptions = {}) => {
  const requests: Request[] = [];
  let seq = 0;
  const id = (p: string) => `${p}-${++seq}`;
  const ok = (result: unknown, info?: unknown) =>
    Response.json({ success: true, errors: [], result, result_info: info });
  const refuse = (status: number, message: string, code = 1000) =>
    Response.json({ success: false, errors: [{ code, message }], result: null }, { status });
  const page = (items: unknown[], url: URL) => {
    const n = Number(url.searchParams.get('page') ?? '1');
    const size = opts.noPageCount ? Number(url.searchParams.get('per_page') ?? PAGE) : PAGE;
    const slice = items.slice((n - 1) * size, n * size);
    const info = opts.noPageCount
      ? { page: n, per_page: size, count: slice.length }
      : { page: n, per_page: size, total_pages: Math.max(1, Math.ceil(items.length / size)) };
    return ok(slice, info);
  };
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const p = url.pathname.replace('/client/v4', '');
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    const req: Request = {
      method,
      path: `${p}${url.search}`,
      body,
      auth: new Headers(init.headers).get('authorization'),
    };
    requests.push(req);
    const raw = opts.raw?.(req);
    if (raw) return raw;
    if (opts.failOn?.(req)) return refuse(500, 'injected failure');
    const a = `/accounts/${ACCOUNT}`;
    let m: RegExpExecArray | null;
    if (/^\/accounts\/[^/]+$/.test(p)) {
      const ours = state.accounts.includes(p.split('/')[2]);
      return ours ? ok({ id: p.split('/')[2] }) : refuse(403, 'Authentication error', 10000);
    }
    if (p === `${a}/access/organizations`) {
      return state.accessEnabled
        ? ok({ auth_domain: state.authDomain })
        : refuse(400, 'access.api.error.not_enabled', 12006);
    }
    if (p === '/zones') return page(state.zones, url);
    if (p === `${a}/workers/domains`) {
      return ok(state.workerDomains.filter((d) => d.hostname === url.searchParams.get('hostname')));
    }
    if ((m = /^\/zones\/([^/]+)\/dns_records$/.exec(p))) {
      return ok((state.dns[m[1]] ?? []).filter((r) => r.name === url.searchParams.get('name')));
    }
    if (p === `${a}/access/identity_providers` && method === 'GET') return page(state.idps, url);
    if (p === `${a}/access/identity_providers` && method === 'POST') {
      const idp = { id: id('idp'), type: String(body?.type) };
      state.idps.push(idp);
      return ok(idp);
    }
    if ((m = /\/d1\/database\/([^/]+)$/.exec(p))) {
      const db = state.d1.find((d) => d.uuid === m![1]);
      return db ? ok(db) : refuse(404, 'not found', 7404);
    }
    if (p === `${a}/d1/database` && method === 'GET') {
      return page(
        state.d1.filter((d) => d.name.includes(url.searchParams.get('name') ?? '')),
        url,
      );
    }
    if (p === `${a}/d1/database` && method === 'POST') {
      const db = {
        uuid: `${'d'.repeat(8)}-0000-0000-0000-${String(++seq).padStart(12, '0')}`,
        name: String(body?.name),
      };
      state.d1.push(db);
      return ok(db);
    }
    // R2 lists by cursor, two buckets at a time.
    if (p === `${a}/r2/buckets` && method === 'GET') {
      const all = state.r2.filter((b) => b.name.includes(url.searchParams.get('name_contains') ?? ''));
      const from = Number(url.searchParams.get('cursor') ?? '0');
      const next = from + PAGE < all.length ? String(from + PAGE) : undefined;
      return ok({ buckets: all.slice(from, from + PAGE) }, { cursor: next });
    }
    if (p === `${a}/r2/buckets` && method === 'POST') {
      state.r2.push({ name: String(body?.name) });
      return ok({ name: body?.name });
    }
    if (p === `${a}/access/policies` && method === 'GET') return page(state.policies, url);
    if (p === `${a}/access/policies` && method === 'POST') {
      const policy = { ...(body as Omit<Policy, 'id'>), id: id('pol') };
      state.policies.push(policy);
      return ok(policy);
    }
    if ((m = /\/access\/policies\/([^/]+)$/.exec(p))) {
      const i = state.policies.findIndex((x) => x.id === m![1]);
      if (i < 0) return refuse(404, 'not found');
      if (method === 'PUT') state.policies[i] = { ...(body as Omit<Policy, 'id'>), id: m[1] };
      return ok(state.policies[i]);
    }
    if (p === `${a}/access/apps` && method === 'GET') {
      return page(
        state.apps.map(({ id: i, domain, name }) => ({ id: i, domain, name })),
        url,
      );
    }
    if (p === `${a}/access/apps` && method === 'POST') {
      const refs = (body?.policies as unknown[]) ?? [];
      const legacy = refs.some((r) => typeof r !== 'object' || r === null || !('id' in r) || 'include' in r);
      if (legacy) return refuse(400, 'legacy policies cannot be added to new applications', 12130);
      const app: App = {
        id: id('app'),
        domain: String(body?.domain),
        type: String(body?.type),
        aud: id('aud'),
        name: String(body?.name),
        allowed_idps: body?.allowed_idps as string[] | undefined,
        policies: refs as { id: string }[],
      };
      state.apps.push(app);
      return ok({ id: app.id, aud: app.aud });
    }
    if ((m = /\/access\/apps\/([^/]+)$/.exec(p))) {
      const app = state.apps.find((x) => x.id === m![1]);
      return app ? ok(app) : refuse(404, 'not found');
    }
    if ((m = /\/workers\/scripts\/([^/]+)\/settings$/.exec(p))) {
      return state.scripts.includes(m[1]) ? ok({}) : refuse(404, 'script not found', 10007);
    }
    return refuse(404, `fake has no route for ${method} ${p}`);
  }) as typeof fetch;
  return { fetchImpl, requests, writes: () => requests.filter((r) => r.method !== 'GET') };
};

export const CONFIG = {
  org: 'acme',
  ownerId: '1001',
  admins: ['owner@acme.dev'],
  sites: [
    {
      repo: 'sidecar',
      teamDomains: ['acme.dev'],
      approvers: ['pm@acme.dev'],
      readers: ['@initech.example', 'riya@partner.example'],
      ticketRepo: 'sidecar',
      branch: 'develop',
      repositoryId: '2001',
      workflow: '.github/workflows/docs.yml',
    },
  ],
};

export const BARE_HUB = {
  accountId: ACCOUNT,
  hostname: 'specs.acme.dev',
  worker: 'specreview-hub',
  database: { name: 'specreview' },
  bucket: { name: 'specreview-sites' },
};

// A throwaway organisation folder and token file.
export const orgDir = (hub: unknown = BARE_HUB, config: unknown = CONFIG) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'specreview-org-'));
  writeFileSync(path.join(dir, 'hub.json'), JSON.stringify(hub));
  writeFileSync(path.join(dir, 'specreview.config.json'), JSON.stringify(config));
  const tokenFile = path.join(dir, 'token');
  writeFileSync(tokenFile, `${TOKEN}\n`);
  return { dir, tokenFile };
};
