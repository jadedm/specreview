import { identify } from './auth';
import { createComment, listComments, reopenThread, replyTo, resolveThread } from './comments';
import { configOf, type HubConfig } from './config';
import type { Ctx, Deps } from './ctx';
import type { Env } from './env';
import { reconcileLabels, ticketsFor } from './github';
import { envTokens } from './github-auth';
import { AppError, errorResponse, json, readJsonBody } from './http';
import { pageOf } from './manifest';
import { isTeam, roleOf, type Role } from './roles';
import { type Route, routeOf } from './routes';
import { changeStatus, listStatuses } from './status';
import { unconfiguredStore } from './store';

type Caller = { email: string; role: Role };
type Req = { request: Request; url: URL; ctx: Ctx; caller: Caller; params: string[] };
type Handler = (req: Req) => Promise<Response>;

const pageParam = (url: URL) => {
  const page = url.searchParams.get('page');
  if (!page) throw new AppError(400, 'VALIDATION_FAILED', 'page: is required');
  return page;
};

const get: Record<string, Handler> = {
  '/me': async ({ caller }) => json(caller),
  '/comments': async ({ ctx, url, caller }) => json(await listComments(ctx, pageParam(url), caller.role)),
  '/status': async ({ ctx }) => json(await listStatuses(ctx)),
  '/tickets': async ({ ctx, url }) =>
    json(await ticketsFor(ctx, (await pageOf(ctx.deps.store, ctx.site.repo, pageParam(url))).issues)),
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

// Old versions are served only to the site's team: they can hold text removed
// before an outside reader was given access.
const serveHistory = async (req: Omit<Req, 'params'>, commit: string, path: string) => {
  if (!isTeam(req.caller.role)) throw new AppError(403, 'FORBIDDEN');
  if (req.request.method !== 'GET') throw new AppError(405, 'METHOD_NOT_ALLOWED');
  const text = await req.ctx.deps.store.history(req.ctx.site.repo, commit, path);
  if (text === null) throw new AppError(404, 'NOT_FOUND');
  return new Response(text, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'",
    },
  });
};

const handle = async (request: Request, env: Env, deps: Deps): Promise<Response> => {
  // Config first: an invalid config refuses everything, / included.
  const config: HubConfig = configOf(env.SPECREVIEW_CONFIG);
  const url = new URL(request.url);
  const route: Route | null = routeOf(url.pathname, config);
  // No site, or nothing under it: 404 before any identity check.
  if (!route) throw new AppError(404, 'NOT_FOUND');
  // Pages are served from the store in #4.
  if (route.kind === 'page') throw new AppError(404, 'NOT_FOUND');
  const ctx: Ctx = { env, deps, config, site: route.site };
  const email = await identify(request, config, route.site);
  const req = { request, url, ctx, caller: { email, role: roleOf(email, route.site) } };
  return route.kind === 'history' ? serveHistory(req, route.commit, route.path) : routeApi(req, route.path);
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
  store: unconfiguredStore,
  github: envTokens(env),
})) satisfies ExportedHandler<Env>;
