import { identify } from './auth';
import { createComment, listComments, reopenThread, replyTo, resolveThread } from './comments';
import { configOf, type HubConfig } from './config';
import type { Caller } from './identity';
import { type Ctx, type Deps, makeCtx } from './ctx';
import type { Env } from './env';
import { reconcileLabels, ticketsFor } from './github';
import { envTokens } from './github-auth';
import { AppError, errorResponse, json, readJsonBody } from './http';
import { pageOf, pagesView } from './manifest';
import { protectedHeaders, servePage } from './pages';
import { publish } from './publish';
import { canRead, isTeam, roleOf } from './roles';
import { serveRoot } from './root';
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

const anonymousPage = (request: Request, route: Route) =>
  route.kind === 'page' &&
  route.site.visibility === 'public' &&
  !request.headers.has('cf-access-jwt-assertion') &&
  (request.method === 'GET' || request.method === 'HEAD');

// A public site's HTML says so in its head, so the review panel stays silent
// for a visitor the hub does not know. Without a sign-in the bytes are the
// same for everyone, so a browser may keep them a minute; with one, never.
const PUBLIC_META = '<meta name="specreview-visibility" content="public">';
const markPublic = (res: Response, shared: boolean): Response => {
  const headers = new Headers(res.headers);
  if (shared) headers.set('cache-control', 'public, max-age=60');
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

const handle = async (request: Request, env: Env, deps: Deps): Promise<Response> => {
  // Config first: an invalid config refuses everything, / included.
  const config: HubConfig = configOf(env.SPECREVIEW_CONFIG);
  const url = new URL(request.url);
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
    return serveRoot(config, await identify(request, config), request.method, deps.store);
  }
  const route: Route | null = routeOf(url.pathname, config);
  // No site, or nothing under it: 404 before any identity check.
  if (!route) throw new AppError(404, 'NOT_FOUND');
  // A public site's pages need no sign-in (#20). Only a request with no
  // Access assertion at all is anonymous: a present but bad one is still 401.
  if (anonymousPage(request, route)) {
    const page = route as Extract<Route, { kind: 'page' }>;
    const served = await servePage(makeCtx(env, deps, config, page.site), request.method, page.path, page.directory);
    return markPublic(served, true);
  }
  const email = await identify(request, config);
  const role = roleOf(email, route.site);
  // Read access is decided before anything about the site is read: someone
  // who may not read it gets the same 403 on every path, published or not.
  if (!canRead(role)) throw new AppError(403, 'FORBIDDEN');
  const ctx: Ctx = makeCtx(env, deps, config, route.site);
  const req = { request, url, ctx, caller: { email, role } };
  const byKind: Record<Route['kind'], () => Promise<Response>> = {
    page: async () => {
      const page = route as Extract<Route, { kind: 'page' }>;
      const served = await servePage(ctx, request.method, page.path, page.directory);
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
  github: envTokens(env),
})) satisfies ExportedHandler<Env>;
