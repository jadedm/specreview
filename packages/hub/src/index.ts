import { adminRoute, serveAdmin } from './admin';
import { identify } from './auth';
import { createComment, listComments, reopenThread, replyTo, resolveThread } from './comments';
import { configOf, type HubConfig } from './config';
import type { Caller } from './identity';
import { type Ctx, type Deps, makeCtx } from './ctx';
import type { Env } from './env';
import { reconcileLabels, ticketsFor } from './github';
import { githubAuthFor } from './github-auth';
import { AppError, errorResponse, json, readJsonBody } from './http';
import { pageOf, pagesView } from './manifest';
import { CACHE_FOREVER, protectedHeaders, servePage } from './pages';
import { withPending } from './pending';
import { handleProtoHost } from './proto';
import { publish } from './publish';
import { canRead, isTeam, roleOf } from './roles';
import { escapeHtml, page, serveRoot } from './root';
import { type Route, routeOf } from './routes';
import { changeStatus, listStatuses } from './status';
import { read, unconfiguredStore } from './store';

type Req = { request: Request; url: URL; ctx: Ctx; caller: Caller; params: string[] };
type Handler = (req: Req) => Promise<Response>;

const pageParam = (url: URL) => {
  const page = url.searchParams.get('page');
  if (!page) throw new AppError(400, 'VALIDATION_FAILED', 'page: is required');
  return page;
};

// The organisation's name and logo for the header (#33): the same for every
// site and every role, since the org's name is not a secret.
const serveLogo = async ({ ctx }: Req): Promise<Response> => {
  const logo = ctx.config.brand?.logo;
  if (!logo) throw new AppError(404, 'NOT_FOUND');
  const object = await read(ctx.deps.store, logo.key);
  if (!object) throw new AppError(404, 'NOT_FOUND');
  return new Response(object.body, {
    headers: { ...protectedHeaders("default-src 'none'"), 'content-type': logo.type },
  });
};

// A site that has never published (#153): a page request gets a page saying
// so, not the API's JSON. Never cached, on a public site too, so it is gone
// the moment the first build lands.
const unpublished = (err: unknown) => err instanceof AppError && err.code === 'SITE_NOT_PUBLISHED';
const notPublishedPage = (config: HubConfig, repo: string, method: string) =>
  page(
    503,
    escapeHtml(config.brand?.name ?? config.org),
    `<h1>Not published yet</h1><p>${escapeHtml(repo)} has no published docs yet. They appear here once its docs workflow publishes them.</p><p class="note"><a href="/">All docs</a></p>`,
    method === 'HEAD',
    undefined,
    'Not published yet',
  );
const pageOrNull = (served: Promise<Response>) =>
  served.catch((err: unknown) => {
    if (unpublished(err)) return null;
    throw err;
  });

const anonymousPage = (request: Request, route: Route) =>
  route.kind === 'page' &&
  route.site.visibility === 'public' &&
  !request.headers.has('cf-access-jwt-assertion') &&
  (request.method === 'GET' || request.method === 'HEAD');

// A public site's HTML says so in its head, so the review panel stays silent
// for a visitor the hub does not know. Without a sign-in the bytes are the
// same for everyone, so a browser may keep them a minute; with one, never.
// A content-addressed asset keeps its own private, year-long header (#104).
const PUBLIC_META = '<meta name="specreview-visibility" content="public">';
const markPublic = (res: Response, shared: boolean): Response => {
  const headers = new Headers(res.headers);
  if (shared && headers.get('cache-control') !== CACHE_FOREVER) headers.set('cache-control', 'public, max-age=60');
  const marked = new Response(res.body, { status: res.status, headers });
  if (!headers.get('content-type')?.startsWith('text/html')) return marked;
  return new HTMLRewriter()
    .on('head', { element: (head) => void head.append(PUBLIC_META, { html: true }) })
    .transform(marked);
};

const get: Record<string, Handler> = {
  '/me': async ({ caller }) => json(caller),
  '/brand': async ({ ctx }) => json({ name: ctx.config.brand?.name ?? null, logo: Boolean(ctx.config.brand?.logo) }),
  '/brand/logo': serveLogo,
  '/comments': async ({ ctx, url, caller }) => json(await listComments(ctx, pageParam(url), caller)),
  '/status': async ({ ctx, caller }) => json(await listStatuses(ctx, caller)),
  '/tickets': async ({ ctx, url, caller }) =>
    json(await ticketsFor(ctx, pageOf(await ctx.snapshot(), pageParam(url)).issues, caller.role)),
  '/pages': async ({ ctx, caller }) => json(pagesView(await ctx.snapshot(), isTeam(caller.role))),
};

const post: Record<string, Handler> = {
  '/comments': async ({ request, ctx, caller }) =>
    json(await createComment(ctx, caller.email, await readJsonBody(request)), 201),
  '/status': async ({ request, ctx, caller }) =>
    json(await changeStatus(ctx, caller.email, caller.role, await readJsonBody(request))),
};

// Thread routes: /comments/<uuid>/<action>.
const threadActions: Record<string, Handler> = {
  replies: async ({ request, ctx, caller, params }) =>
    json(await replyTo(ctx, caller.email, params[0], await readJsonBody(request)), 201),
  resolve: async ({ request, ctx, caller, params }) =>
    json(await resolveThread(ctx, caller.email, caller.role, params[0], await readJsonBody(request))),
  reopen: async ({ request, ctx, caller, params }) =>
    json(await reopenThread(ctx, caller.email, caller.role, params[0], await readJsonBody(request))),
};
const THREAD_ROUTE = /^\/comments\/([0-9a-f-]{36})\/(replies|resolve|reopen)$/;

const routeApi = (req: Omit<Req, 'params'>, path: string): Promise<Response> => {
  const thread = THREAD_ROUTE.exec(path);
  const byMethod: Record<string, () => Handler | undefined> = {
    GET: () => (thread || !Object.hasOwn(get, path) ? undefined : get[path]),
    POST: () => (thread ? threadActions[thread[2]] : Object.hasOwn(post, path) ? post[path] : undefined),
  };
  const handler = Object.hasOwn(byMethod, req.request.method) ? byMethod[req.request.method]() : undefined;
  if (handler) return handler({ ...req, params: thread ? [thread[1]] : [] });
  const known = Object.hasOwn(get, path) || Object.hasOwn(post, path) || thread !== null;
  if (known) throw new AppError(405, 'METHOD_NOT_ALLOWED');
  throw new AppError(404, 'NOT_FOUND');
};

const sha256Hex = async (bytes: ArrayBuffer) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

// Old versions are served only to the site's team: they can hold text removed
// before an outside reader was given access.
const serveHistory = async (req: Omit<Req, 'params'>, commit: string, path: string) => {
  if (!isTeam(req.caller.role)) throw new AppError(403, 'FORBIDDEN');
  if (req.request.method !== 'GET') throw new AppError(405, 'METHOD_NOT_ALLOWED');
  const obj = await read(req.ctx.deps.store, `${req.ctx.site.repo}/history/${commit}/${path}`);
  if (obj === null) throw new AppError(404, 'NOT_FOUND');
  // The bytes as stored, as publish hashed them: decoding as text would drop
  // a leading byte-order mark and the hash would no longer match.
  const bytes = await new Response(obj.body).arrayBuffer().catch((e: unknown) => {
    console.error('store read failed', e instanceof Error ? e.message : String(e));
    throw new AppError(503, 'STORAGE_UNAVAILABLE', 'Storage is unavailable; try again shortly.');
  });
  // Only an old version the live manifest lists, with the hash it records:
  // history keys are shared across publishes, so nothing a publish that never
  // went live wrote can be shown.
  const { manifest } = await req.ctx.snapshot();
  const entry = Object.values(manifest.pages)
    .flatMap((p) => p.history)
    .find((h) => h.commit === commit && h.path === path);
  if (!entry || entry.hash !== (await sha256Hex(bytes))) throw new AppError(404, 'NOT_FOUND');
  return new Response(bytes, {
    headers: { ...protectedHeaders("default-src 'none'"), 'content-type': 'text/plain; charset=utf-8' },
  });
};

const isAdminPath = (pathname: string) => pathname === '/_admin' || pathname.startsWith('/_admin/');
const redirect = (status: number, location: string) =>
  new Response(null, { status, headers: { location, 'cache-control': 'no-store' } });

// The admin page's own hostname (#75) serves the admin page and nothing else,
// verified against its own Access application, so no docs site shares its
// origin.
const handleAdminHost = async (
  request: Request,
  url: URL,
  env: Env,
  config: HubConfig,
  deps: Deps,
  admin: { aud: string },
): Promise<Response> => {
  if (url.pathname === '/' && (request.method === 'GET' || request.method === 'HEAD')) return redirect(302, '/_admin/');
  // The admin page's address without its slash (#62); nothing else is.
  if (url.pathname === '/_admin') return redirect(308, '/_admin/');
  const route = url.pathname.startsWith('/_admin/') ? adminRoute(url.pathname) : null;
  // Unknown paths 404 before any identity check.
  if (!route) throw new AppError(404, 'NOT_FOUND');
  const email = await identify(request, config, admin.aud);
  return serveAdmin(route, { request, url, env, config, email, deps });
};

// The docs hostname only points at the admin page: a GET goes to the same
// path on the admin hostname, anything else is not here (#75).
const adminFromDocsHost = (request: Request, url: URL, config: HubConfig) => {
  const navigation = request.method === 'GET' || request.method === 'HEAD';
  if (config.admin && navigation) {
    const target = url.pathname === '/_admin' ? '/_admin/' : url.pathname;
    return redirect(308, `https://${config.admin.hostname}${target}${url.search}`);
  }
  if (!navigation || (url.pathname !== '/_admin' && !adminRoute(url.pathname))) throw new AppError(404, 'NOT_FOUND');
  return page(
    404,
    'Admin page',
    "<h1>The admin page needs its own hostname</h1><p>This hub has none set up. Its administrators add <code>adminHostname</code> to the hub repo's <code>hub.json</code>; the apply workflow then creates it.</p>",
    request.method === 'HEAD',
  );
};

const handle = async (request: Request, env: Env, deps: Deps): Promise<Response> => {
  // Config first: an invalid config refuses everything, / included.
  const config: HubConfig = configOf(env.SPECREVIEW_CONFIG);
  const url = new URL(request.url);
  if (config.admin && url.hostname === config.admin.hostname)
    return handleAdminHost(request, url, env, config, deps, config.admin);
  // Prototypes have a hostname of their own (#112), and nothing else is there.
  if (config.proto && url.hostname === config.proto.hostname)
    return handleProtoHost(request, url, env, config, deps, config.proto);
  // Publishing authenticates with GitHub's OIDC token, not Access: Access
  // bypasses exactly /_publish/* (set up at deploy) and the hub checks the
  // token itself. Repo names never start with _, so this cannot shadow a site.
  const publishing = /^\/_publish\/([^/]+)$/.exec(url.pathname);
  if (publishing) {
    const site = config.sites.get(publishing[1]);
    if (!site) throw new AppError(404, 'NOT_FOUND');
    return publish(request, env, config, site);
  }
  // The bare address shows a signed-in visitor an index of their sites (#43, #45).
  if (url.pathname === '/' && (request.method === 'GET' || request.method === 'HEAD')) {
    return serveRoot(config, await identify(request, config), request.method, deps.store, env);
  }
  // The admin page (#56) lives on its own hostname (#75).
  if (isAdminPath(url.pathname)) return adminFromDocsHost(request, url, config);
  const route: Route | null = routeOf(url.pathname, config);
  // No site, or nothing under it: 404 before any identity check.
  if (!route) throw new AppError(404, 'NOT_FOUND');
  // A public site's pages need no sign-in (#20). Only a request with no
  // Access assertion at all is anonymous: a present but bad one is still 401.
  if (anonymousPage(request, route)) {
    const page = route as Extract<Route, { kind: 'page' }>;
    const served = await pageOrNull(
      servePage(makeCtx(env, deps, config, page.site), request.method, page.path, page.directory, url.search),
    );
    if (!served) return notPublishedPage(config, page.site.repo, request.method);
    return markPublic(served, true);
  }
  const email = await identify(request, config);
  // Removals made on the admin page count before the deploy that carries them
  // (#12). They only take access away, so someone the config already refuses
  // is refused without a database read.
  const configured = roleOf(email, route.site);
  const role = configured === 'none' ? configured : roleOf(email, await withPending(env, route.site));
  // Read access is decided before anything about the site is read: someone
  // who may not read it gets the same 403 on every path, published or not.
  if (!canRead(role)) throw new AppError(403, 'FORBIDDEN');
  const ctx: Ctx = makeCtx(env, deps, config, route.site);
  const req = { request, url, ctx, caller: { email, role } };
  const byKind: Record<Route['kind'], () => Promise<Response>> = {
    page: async () => {
      const page = route as Extract<Route, { kind: 'page' }>;
      const served = await pageOrNull(servePage(ctx, request.method, page.path, page.directory, url.search));
      if (!served) return notPublishedPage(config, page.site.repo, request.method);
      return page.site.visibility === 'public' ? markPublic(served, false) : served;
    },
    // Access signed the visitor in on the way here; send them to the site.
    signin: async () =>
      new Response(null, {
        status: 302,
        headers: { location: `/${route.site.repo}/`, 'cache-control': 'private, no-store' },
      }),
    history: () => {
      const h = route as Extract<Route, { kind: 'history' }>;
      return serveHistory(req, h.commit, h.path);
    },
    api: () => routeApi(req, (route as Extract<Route, { kind: 'api' }>).path),
  };
  return byKind[route.kind]();
};

export const createHub = (makeDeps: (env: Env) => Deps) => ({
  fetch: (request: Request, env: Env, _ctx: ExecutionContext) =>
    handle(request, env, makeDeps(env)).catch(errorResponse),
  scheduled: (_controller: ScheduledController, env: Env, ctx: ExecutionContext) =>
    ctx.waitUntil(
      Promise.resolve()
        .then(() => reconcileLabels({ env, deps: makeDeps(env), config: configOf(env.SPECREVIEW_CONFIG) }))
        .catch((err: unknown) => console.error('cron failed', err instanceof Error ? err.message : String(err))),
    ),
});

export default createHub((env) => ({
  store: env.SITES ?? unconfiguredStore,
  github: githubAuthFor(env),
})) satisfies ExportedHandler<Env>;
