// Prototypes on a hostname of their own (#112, epic #110): the files a build
// published untouched (its proto/ part, stored at <repo>/p/<version>/), served
// only here, verified against this hostname's own Access application, to
// those who may read the site. Nothing else of the hub is reachable here, and
// the docs hostname never reads p/, so a prototype's scripts never run with a
// docs or admin origin.
import { identify } from './auth';
import type { HubConfig } from './config';
import { type Deps, makeCtx } from './ctx';
import type { Env } from './env';
import { AppError } from './http';
import { extensionOf, TYPES } from './pages';
import { withPending } from './pending';
import { canRead, roleOf } from './roles';
import { page } from './root';
import { read } from './store';

// An exported mockup compiles its template in the browser and loads its
// libraries and fonts from these hosts (the spike on #112); it may talk only
// to this hostname, be framed by nothing, and post forms nowhere.
export const PROTO_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

const SEGMENT = /^[A-Za-z0-9._~-]+$/;
const plain = (s: string) => SEGMENT.test(s) && s !== '.' && s !== '..';
const RESERVED = new Set(['_api', '_history', '_signin']);
// Markdown notes beside a prototype read as text.
const typeOf = (path: string) => {
  const ext = extensionOf(path);
  if (ext === 'md') return 'text/plain; charset=utf-8';
  return Object.hasOwn(TYPES, ext) ? TYPES[ext] : 'application/octet-stream';
};

// A miss is a page with the way back to the docs (#125), not the API's JSON:
// people reach this hostname by typing it or trimming a prototype's address.
// It names no site and no organisation, so it may answer before any sign-in.
const notFound = (docsHostname: string, head: boolean) =>
  page(
    404,
    'Prototypes',
    `<h1>Prototype not found</h1><p>Nothing is published at this address.</p><p class="note"><a href="https://${docsHostname}/">Go to the docs</a></p>`,
    head,
  );

export const handleProtoHost = async (
  request: Request,
  url: URL,
  env: Env,
  config: HubConfig,
  deps: Deps,
  proto: { aud: string; docsHostname: string },
): Promise<Response> => {
  const head = request.method === 'HEAD';
  const reads = request.method === 'GET' || head;
  // The hostname alone leads to the docs' index, where the sites are listed.
  if (url.pathname === '/' && reads)
    return new Response(null, {
      status: 302,
      headers: { location: `https://${proto.docsHostname}/`, 'cache-control': 'private, no-store' },
    });
  // /<repo>/<path>, a trailing slash meaning that folder's index.html; any
  // other shape is not here, before any identity check.
  const [, repo, ...rest] = url.pathname.split('/');
  const site = repo ? config.sites.get(repo) : undefined;
  const directory = url.pathname.endsWith('/');
  const parts = directory ? rest.slice(0, -1) : rest;
  if (!site || parts.length === 0 || !parts.every(plain) || RESERVED.has(parts[0]))
    return notFound(proto.docsHostname, head);
  const path = directory ? `${parts.join('/')}/index.html` : parts.join('/');
  const email = await identify(request, config, proto.aud);
  // Who may read the site may open its prototypes; removals count first (#12).
  // Anyone else gets the page a name that is not a site gets, whatever the
  // method (#176).
  const configured = roleOf(email, site);
  const role = configured === 'none' ? configured : roleOf(email, await withPending(env, site));
  if (!canRead(role)) return notFound(proto.docsHostname, head);
  if (!reads) throw new AppError(405, 'METHOD_NOT_ALLOWED');
  // The live version only: a version is never chosen by the URL. What is
  // stored there is exactly the manifest's list (publish refuses any other).
  const snapshot = await makeCtx(env, deps, config, site).snapshot();
  const obj = await read(deps.store, `${site.repo}/p/${snapshot.version}/${path}`);
  if (!obj) return notFound(proto.docsHostname, head);
  const headers = {
    'content-type': typeOf(path),
    'content-security-policy': PROTO_CSP,
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    'x-frame-options': 'DENY',
  };
  if (head) {
    await obj.body?.cancel();
    return new Response(null, { headers });
  }
  return new Response(obj.body, { headers });
};
