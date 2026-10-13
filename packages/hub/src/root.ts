// The hub's bare address (#43, #45). Access protects it, so whoever reaches
// the Worker here has signed in: an index of the sites they may read, one or
// many; none is a refusal that names no site.
import type { HubConfig } from './config';
import { protectedHeaders } from './pages';
import { canRead, roleOf } from './roles';

const STYLE =
  'body{font-family:system-ui,-apple-system,"Segoe UI","Helvetica Neue",Arial,sans-serif;color:#1f1f1f;background:#fff;max-width:560px;margin:64px auto;padding:0 16px;line-height:1.6}h1{font-size:20px}a{color:#1f1f1f}li{margin:6px 0}';

const sha256 = async (text: string) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
};

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

// HEAD gets the same status and headers with no body, as pages.ts does.
const page = async (status: number, title: string, body: string, head: boolean) =>
  new Response(
    head
      ? null
      : `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${STYLE}</style></head><body>${body}</body></html>`,
    {
      status,
      headers: {
        ...protectedHeaders(`default-src 'none'; style-src 'sha256-${await sha256(STYLE)}'`),
        'content-type': 'text/html; charset=utf-8',
      },
    },
  );

export const serveRoot = async (config: HubConfig, email: string, method: string): Promise<Response> => {
  const head = method === 'HEAD';
  const readable = [...config.sites.values()].filter((site) => canRead(roleOf(email, site)));
  const name = escapeHtml(config.brand?.name ?? config.org);
  if (readable.length === 0) {
    return page(
      403,
      name,
      `<h1>${name}</h1><p>This account has no docs on this hub. Ask the team that sent you the link to add you.</p>`,
      head,
    );
  }
  // Repo names are [a-z0-9._-] (config.ts), so they need no escaping.
  const links = readable.map((s) => `<li><a href="/${s.repo}/">${s.repo}</a></li>`).join('');
  return page(200, name, `<h1>${name}</h1><ul>${links}</ul>`, head);
};
