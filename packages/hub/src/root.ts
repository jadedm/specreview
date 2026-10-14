// The hub's bare address (#43, #45, #48, #52). Access protects it, so whoever
// reaches the Worker here has signed in: an index of the sites they may read,
// one or many; none is a refusal that names no site but says who is signed
// in and how to switch. It wears the sites' house style (#32): true greys,
// the system font, no script.
import type { HubConfig, Site } from './config';
import type { Env } from './env';
import { snapshotOf } from './manifest';
import { protectedHeaders } from './pages';
import { canRead, roleOf } from './roles';
import { effectiveStatus, readSiteStatuses } from './status-read';
import type { SiteStore } from './store';

const STYLE = [
  '*{box-sizing:border-box}',
  'body{margin:0;font-family:system-ui,-apple-system,"Segoe UI","Helvetica Neue",Arial,sans-serif;color:#1f1f1f;background:#fff;line-height:1.6;-webkit-font-smoothing:antialiased}',
  'header{border-bottom:1px solid #e2e2e2}',
  // The bar's contents share the content's column (#50).
  '.bar{max-width:688px;height:64px;margin:0 auto;padding:0 24px;display:flex;align-items:center}',
  '.org{font-size:16px;font-weight:600}',
  'main{max-width:688px;margin:48px auto;padding:0 24px}',
  'h1{font-size:28px;line-height:1.25;font-weight:600;margin:0 0 24px}',
  'p{margin:0 0 12px}',
  '.note{color:#6b6b6b}',
  'main a{color:inherit}',
  'ul{list-style:none;margin:0;padding:0;border-top:1px solid #e2e2e2}',
  'li{border-bottom:1px solid #e2e2e2}',
  '.site{display:block;padding:16px 12px;margin:0 -12px;color:inherit;text-decoration:none}',
  '.site:hover{background:#f6f6f6}',
  'a:focus-visible{outline:2px solid #1f1f1f;outline-offset:2px}',
  '.title{display:block;font-size:18px;font-weight:600;line-height:1.4}',
  '.meta{display:block;font-size:14px;color:#6b6b6b}',
  // The admin page's buttons (#56): a dark fill, the same focus ring.
  'form{margin:24px 0}',
  'button{font:inherit;font-size:15px;font-weight:600;color:#fff;background:#1f1f1f;border:0;border-radius:6px;padding:10px 16px;cursor:pointer}',
  'button:hover{background:#3d3d3d}',
  'button:focus-visible{outline:2px solid #1f1f1f;outline-offset:2px}',
  '.quiet{color:#1f1f1f;background:#fff;border:1px solid #c4c4c4}',
  '.quiet:hover{background:#f6f6f6}',
  'h2{font-size:18px;font-weight:600;margin:32px 0 8px}',
  '@media (max-width:640px){.bar{padding:0 16px}main{margin:32px auto;padding:0 16px}h1{font-size:24px}}',
].join('');

const sha256 = async (text: string) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
};

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

// HEAD gets the same status and headers with no body, as pages.ts does. A
// page with forms names where they may post (form-action does not fall back
// to default-src).
export const page = async (status: number, name: string, main: string, head: boolean, formAction?: string) =>
  new Response(
    head
      ? null
      : `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${name}</title><style>${STYLE}</style></head><body><header><div class="bar"><span class="org">${name}</span></div></header><main>${main}</main></body></html>`,
    {
      status,
      headers: {
        ...protectedHeaders(
          `default-src 'none'; style-src 'sha256-${await sha256(STYLE)}'${formAction ? `; form-action ${formAction}` : ''}`,
        ),
        'content-type': 'text/html; charset=utf-8',
      },
    },
  );

// What a row says about a site: its title, and a line with its page count,
// pages in review and ready, and when it was built. Anything that cannot be
// read in time leaves the repo name and no line, so one site can neither
// break nor stall the page.
export const TITLE_WAIT_MS = 2_000;
type Row = { title: string; line: string | null };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayOf = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const lineOf = async (env: Env, site: Site, pages: Record<string, { hash: string }>, builtAt: string) => {
  const byPage = new Map((await readSiteStatuses(env, site.key)).map((r) => [r.page, r]));
  const statuses = Object.entries(pages).map(
    ([page, entry]) => effectiveStatus(byPage.get(page) ?? null, entry.hash).status,
  );
  const inReview = statuses.filter((s) => s === 'in_review').length;
  const ready = statuses.filter((s) => s === 'ready').length;
  const day = dayOf(builtAt);
  return [
    plural(statuses.length, 'page', 'pages'),
    inReview > 0 ? `${inReview} in review` : null,
    ready > 0 ? `${ready} ready to build` : null,
    day ? `updated ${day}` : null,
  ]
    .filter(Boolean)
    .join(', ');
};

// Each read has its own limit: a slow database costs a row its line, never
// its title.
const within = <T>(p: Promise<T>, fallback: T) =>
  Promise.race([
    p.catch(() => fallback),
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), TITLE_WAIT_MS)),
  ]);

const rowOf = async (env: Env, store: SiteStore, site: Site): Promise<Row> => {
  const snapshot = await within(snapshotOf(store, site.repo), null);
  if (!snapshot) return { title: site.repo, line: null };
  const { pages, builtAt } = snapshot.manifest;
  return {
    title: pages.index?.title || site.repo,
    line: await within(lineOf(env, site, pages, builtAt), null),
  };
};

export const serveRoot = async (
  config: HubConfig,
  email: string,
  method: string,
  store: SiteStore,
  env: Env,
): Promise<Response> => {
  const head = method === 'HEAD';
  const readable = [...config.sites.values()].filter((site) => canRead(roleOf(email, site)));
  const name = escapeHtml(config.brand?.name ?? config.org);
  if (readable.length === 0) {
    // Access's own sign-out ends the session, so the next visit asks for an
    // email again.
    return page(
      403,
      name,
      `<h1>No docs here</h1><p>You're signed in as ${escapeHtml(email)}, which has no docs on this hub.</p><p class="note">Ask the team that sent you the link to add you, or <a href="/cdn-cgi/access/logout">sign in with another email</a>.</p>`,
      head,
    );
  }
  // HEAD answers the same status and headers without reading anything.
  if (head) return page(200, name, '', true);
  const rows = await Promise.all(readable.map((s) => rowOf(env, store, s)));
  // Repo names are [a-z0-9._-] (config.ts), so they need no escaping in a path.
  const items = readable
    .map((s, i) => {
      const line = rows[i].line ? `<span class="meta">${escapeHtml(rows[i].line as string)}</span>` : '';
      return `<li><a class="site" href="/${s.repo}/"><span class="title">${escapeHtml(rows[i].title)}</span>${line}</a></li>`;
    })
    .join('');
  return page(200, name, `<h1>${name} docs</h1><ul>${items}</ul>`, head);
};
