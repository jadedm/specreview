import type { Ctx } from './ctx';
import { AppError } from './http';
import { cspOf, type Snapshot } from './manifest';
import { read } from './store';
import { isContentAddressed } from '@specreview/shared';

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
  pdf: 'application/pdf',
  xml: 'application/xml; charset=utf-8',
};

const extensionOf = (path: string) => {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

// A content-addressed file (#104, isContentAddressed in @specreview/shared:
// code and style with no page text, never a page chunk) may stay in the
// reader's own browser. Private, never public, so no shared cache holds it.
export const CACHE_FOREVER = 'private, max-age=31536000, immutable';

// Content behind sign-in is never stored by any cache, the browser's included
// (the content-addressed code above holds no page text).
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
  // A known file type is served as named; anything else may be a clean URL
  // with a dot in it (release-1.2 is release-1.2.html).
  if (Object.hasOwn(TYPES, extensionOf(path))) return [path, `${path}.html`, `${path}/index.html`];
  return [`${path}.html`, `${path}/index.html`, path];
};

const INERT = "default-src 'none'; sandbox";

// The manifest holds history metadata (authors, PRs) that only the team sees.
const HIDDEN = new Set(['manifest.json']);

export const servePage = async (ctx: Ctx, method: string, path: string, directory: boolean): Promise<Response> => {
  if (method !== 'GET' && method !== 'HEAD') throw new AppError(405, 'METHOD_NOT_ALLOWED');
  const snapshot: Snapshot = await ctx.snapshot();
  for (const candidate of HIDDEN.has(path) ? [] : candidates(path, directory)) {
    const obj = await read(ctx.deps.store, `${ctx.site.repo}/v/${snapshot.version}/${candidate}`);
    if (!obj) continue;
    const ext = extensionOf(candidate);
    const known = Object.hasOwn(TYPES, ext);
    // Only pages run anything: every other file, opened on its own, gets a
    // policy that runs nothing (an SVG or XML file can hold script).
    const headers: Record<string, string> = {
      ...protectedHeaders(ext === 'html' ? cspOf(snapshot) : INERT),
      'content-type': known ? TYPES[ext] : 'application/octet-stream',
    };
    if (isContentAddressed(candidate)) headers['cache-control'] = CACHE_FOREVER;
    // Anything not in the table, SVG and PDF (#97) download instead of
    // rendering in the origin; an <img> of an SVG still shows it.
    if (!known || ext === 'svg' || ext === 'pdf') headers['content-disposition'] = 'attachment';
    if (method === 'HEAD') {
      await obj.body?.cancel();
      return new Response(null, { headers });
    }
    return new Response(obj.body, { headers });
  }
  return notFoundPage(ctx, snapshot, method);
};

// A stale link gets the site's own 404 page, as VitePress built it, with the
// site's headers and CSP (#17); a build without one gets the JSON 404.
const notFoundPage = async (ctx: Ctx, snapshot: Snapshot, method: string): Promise<Response> => {
  const page = await read(ctx.deps.store, `${ctx.site.repo}/v/${snapshot.version}/404.html`);
  if (!page) throw new AppError(404, 'NOT_FOUND');
  const headers = { ...protectedHeaders(cspOf(snapshot)), 'content-type': TYPES.html };
  if (method === 'HEAD') {
    await page.body?.cancel();
    return new Response(null, { status: 404, headers });
  }
  return new Response(page.body, { status: 404, headers });
};
