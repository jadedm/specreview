// The hub's bare address (#43, #45, #48). Access protects it, so whoever
// reaches the Worker here has signed in: an index of the sites they may read,
// one or many; none is a refusal that names no site. It wears the sites'
// house style (#32): true greys, the system font, no script.
import type { HubConfig, Site } from './config';
import { snapshotOf } from './manifest';
import { protectedHeaders } from './pages';
import { canRead, roleOf } from './roles';
import type { SiteStore } from './store';

const STYLE = [
  '*{box-sizing:border-box}',
  'body{margin:0;font-family:system-ui,-apple-system,"Segoe UI","Helvetica Neue",Arial,sans-serif;color:#1f1f1f;background:#fff;line-height:1.6;-webkit-font-smoothing:antialiased}',
  'header{height:64px;display:flex;align-items:center;padding:0 32px;border-bottom:1px solid #e2e2e2}',
  '.org{font-size:16px;font-weight:600}',
  'main{max-width:688px;margin:48px auto;padding:0 24px}',
  'h1{font-size:28px;line-height:1.25;font-weight:600;margin:0 0 8px}',
  '.lede{color:#6b6b6b;margin:0 0 32px}',
  'ul{list-style:none;margin:0;padding:0}',
  'li{margin:0 0 12px}',
  '.site{display:block;padding:16px 20px;border:1px solid #e2e2e2;border-radius:8px;color:inherit;text-decoration:none}',
  '.site:hover{border-color:#8a8a8a;background:#f6f6f6}',
  '.site:focus-visible{outline:2px solid #1f1f1f;outline-offset:2px}',
  '.title{display:block;font-size:16px;font-weight:600}',
  '.path{display:block;font-size:14px;color:#6b6b6b}',
  '@media (max-width:640px){header{padding:0 16px}main{margin:32px auto;padding:0 16px}h1{font-size:24px}}',
].join('');

const sha256 = async (text: string) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
};

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

// HEAD gets the same status and headers with no body, as pages.ts does.
const page = async (status: number, name: string, main: string, head: boolean) =>
  new Response(
    head
      ? null
      : `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${name}</title><style>${STYLE}</style></head><body><header><span class="org">${name}</span></header><main>${main}</main></body></html>`,
    {
      status,
      headers: {
        ...protectedHeaders(`default-src 'none'; style-src 'sha256-${await sha256(STYLE)}'`),
        'content-type': 'text/html; charset=utf-8',
      },
    },
  );

// The site's own title, from its live index page; its repo name when it is
// not published, has no titled index, cannot be read, or the store does not
// answer in time, so the index never fails or stalls over one site.
export const TITLE_WAIT_MS = 2_000;
const titleOf = (store: SiteStore, site: Site) =>
  Promise.race([
    snapshotOf(store, site.repo).then(
      (s) => s.manifest.pages.index?.title || site.repo,
      () => site.repo,
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve(site.repo), TITLE_WAIT_MS)),
  ]);

export const serveRoot = async (
  config: HubConfig,
  email: string,
  method: string,
  store: SiteStore,
): Promise<Response> => {
  const head = method === 'HEAD';
  const readable = [...config.sites.values()].filter((site) => canRead(roleOf(email, site)));
  const name = escapeHtml(config.brand?.name ?? config.org);
  if (readable.length === 0) {
    return page(
      403,
      name,
      `<h1>No docs here</h1><p class="lede">This account has no docs on this hub. Ask the team that sent you the link to add you.</p>`,
      head,
    );
  }
  const titles = await Promise.all(readable.map((s) => titleOf(store, s)));
  // Repo names are [a-z0-9._-] (config.ts), so they need no escaping in a path.
  const rows = readable
    .map(
      (s, i) =>
        `<li><a class="site" href="/${s.repo}/"><span class="title">${escapeHtml(titles[i])}</span><span class="path">/${s.repo}/</span></a></li>`,
    )
    .join('');
  return page(200, name, `<h1>Docs</h1><p class="lede">Everything you can read on this hub.</p><ul>${rows}</ul>`, head);
};
