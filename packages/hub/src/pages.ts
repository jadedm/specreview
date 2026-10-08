import type { Ctx } from './ctx';
import { AppError } from './http';
import { cspOf, type Snapshot } from './manifest';
import { read } from './store';

// Pages and assets of the site's published version, served only after the
// caller is known to be allowed to read the site (index.ts).

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  txt: 'text/plain; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
};

const extensionOf = (path: string) => {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

// Content behind sign-in is never stored by any cache, the browser's included.
export const protectedHeaders = (csp: string): Record<string, string> => ({
  'cache-control': 'private, no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'x-frame-options': 'DENY',
  'content-security-policy': csp,
});

// For /<repo>/a/b: a/b.html, then a/b/index.html, then the file a/b. A
// directory path (trailing slash) is its index.html; the site root is index.html.
const candidates = (path: string, directory: boolean): string[] => {
  if (path === '') return ['index.html'];
  if (directory) return [`${path}/index.html`];
  if (extensionOf(path) !== '') return [path];
  return [`${path}.html`, `${path}/index.html`, path];
};

// The manifest holds history metadata (authors, PRs) that only the team sees.
const HIDDEN = new Set(['manifest.json']);

export const servePage = async (ctx: Ctx, method: string, path: string, directory: boolean): Promise<Response> => {
  if (method !== 'GET' && method !== 'HEAD') throw new AppError(405, 'METHOD_NOT_ALLOWED');
  if (HIDDEN.has(path)) throw new AppError(404, 'NOT_FOUND');
  const snapshot: Snapshot = await ctx.snapshot();
  for (const candidate of candidates(path, directory)) {
    const obj = await read(ctx.deps.store, `${ctx.site.repo}/v/${snapshot.version}/${candidate}`);
    if (!obj) continue;
    const ext = extensionOf(candidate);
    const known = Object.hasOwn(TYPES, ext);
    const headers: Record<string, string> = {
      ...protectedHeaders(cspOf(snapshot)),
      'content-type': known ? TYPES[ext] : 'application/octet-stream',
    };
    // Anything not in the table downloads instead of rendering in the origin.
    if (!known) headers['content-disposition'] = 'attachment';
    if (method === 'HEAD') {
      await obj.body?.cancel();
      return new Response(null, { headers });
    }
    return new Response(obj.body, { headers });
  }
  throw new AppError(404, 'NOT_FOUND');
};
