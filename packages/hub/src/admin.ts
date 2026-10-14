import type { HubConfig } from './config';
import type { Deps } from './ctx';
import type { Env } from './env';
import { forgetStoredAuth } from './github-auth';
import { AppError } from './http';
import { escapeHtml, page } from './root';
import { seal } from './seal';
import { findApp, forgetApp, saveApp, type Found } from './stored-app';

// The hub's admin page (#56), for the config's admins only: create the
// organisation's GitHub App with GitHub's app-manifest flow, see where it is
// installed, or forget it. Access covers these paths like every other but
// /_publish/* and public sites' pages; the hub checks the admin itself.

const API = 'https://api.github.com';
const STATE_TTL_MS = 60 * 60_000;
const STATES_PER_ADMIN = 10;
const INSTALLED_WAIT_MS = 3_000;
const BACK = '<p><a href="/_admin/">Back to the admin page</a></p>';

type Admin = { request: Request; url: URL; env: Env; config: HubConfig; email: string; deps: Deps };
type Route = { method: string; run: (a: Admin) => Promise<Response> };

const nameOf = (config: HubConfig) => escapeHtml(config.brand?.name ?? config.org);
const say = (a: Admin, status: number, title: string, body: string) =>
  page(status, nameOf(a.config), `<h1>${escapeHtml(title)}</h1>${body}${BACK}`, false);

const envApp = (env: Env) => Boolean(env.GITHUB_APP_ID?.trim() || env.GITHUB_APP_PRIVATE_KEY);
const hubKeySet = (env: Env) =>
  seal(env.SPECREVIEW_KEY, 'probe', '').then(
    () => true,
    () => false,
  );

// GitHub caps app names at 34 characters; its form lets the admin change one
// that is taken.
export const manifestFor = (config: HubConfig, origin: string) => ({
  name: `specreview ${config.org}`.slice(0, 34),
  url: origin,
  hook_attributes: { url: origin, active: false },
  redirect_url: `${origin}/_admin/github/created`,
  public: false,
  // What the hub uses today; adding sites (#57) asks for more when it needs it.
  default_permissions: { issues: 'write', metadata: 'read' },
  default_events: [],
});

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

// Single use, an hour long, the admin's own; an admin keeps at most ten.
const newState = async (env: Env, email: string) => {
  const state = hex(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM admin_states WHERE expires_at <= ?').bind(now),
    env.DB.prepare(
      'DELETE FROM admin_states WHERE email = ? AND state NOT IN (SELECT state FROM admin_states WHERE email = ? ORDER BY expires_at DESC LIMIT ?)',
    ).bind(email, email, STATES_PER_ADMIN - 1),
    env.DB.prepare('INSERT INTO admin_states (state, email, expires_at) VALUES (?, ?, ?)').bind(
      state,
      email,
      now + STATE_TTL_MS,
    ),
  ]);
  return state;
};

const takeState = async (env: Env, email: string, state: string) =>
  (await env.DB.prepare('DELETE FROM admin_states WHERE state = ? AND email = ? AND expires_at > ? RETURNING state')
    .bind(state, email, Date.now())
    .first()) !== null;

const within = <T>(p: Promise<T>, fallback: T) =>
  Promise.race([p.catch(() => fallback), new Promise<T>((r) => setTimeout(() => r(fallback), INSTALLED_WAIT_MS))]);

const ticketRepos = (config: HubConfig) => [...new Set([...config.sites.values()].map((s) => s.ticketRepo))];

const installations = async (a: Admin) => {
  const repos = ticketRepos(a.config);
  const states = await Promise.all(
    repos.map((r) => within(a.deps.github.installed?.(r) ?? Promise.resolve(null), null)),
  );
  const word = (s: boolean | null) => (s === null ? 'could not check' : s ? 'installed' : 'not installed');
  const items = repos.map(
    (r, i) =>
      `<li><span class="site"><span class="title">${escapeHtml(r)}</span><span class="meta">${word(states[i])}</span></span></li>`,
  );
  return `<h2>Ticket repos</h2><ul>${items.join('')}</ul>`;
};

const FORGET =
  '<form method="post" action="/_admin/github/forget"><button class="quiet" type="submit">Forget this app</button></form>';

const createForm = async (a: Admin) => {
  const state = await newState(a.env, a.email);
  const manifest = escapeHtml(JSON.stringify(manifestFor(a.config, a.url.origin)));
  return `<p>The hub reads tickets and sets labels as a GitHub App that ${escapeHtml(a.config.org)} owns. Create it on GitHub, where you can change its name, then install it on the repos it should use.</p><form method="post" action="https://github.com/organizations/${encodeURIComponent(a.config.org)}/settings/apps/new?state=${state}"><input type="hidden" name="manifest" value="${manifest}"><button type="submit">Create the app on GitHub</button></form>`;
};

const dateOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const bodyFor = async (a: Admin, found: Found) => {
  if (envApp(a.env))
    return `<p>This hub uses the GitHub App set in its Worker secrets (GITHUB_APP_ID). To manage the app from here instead, remove those secrets.</p>${await installations(a)}`;
  if (found.kind === 'locked')
    return `<p>The app ${escapeHtml(found.app.slug)} is stored, but this hub's key no longer opens it (${escapeHtml(found.why)}). Forget it, delete it on GitHub, and create a new one.</p>${FORGET}`;
  if (found.kind === 'app') {
    const { slug, createdBy, createdAt } = found.app;
    return `<p>The hub uses the GitHub App <strong>${escapeHtml(slug)}</strong>, created by ${escapeHtml(createdBy)} on ${dateOf(createdAt)}.</p><p><a href="https://github.com/apps/${encodeURIComponent(slug)}/installations/new">Choose the repos it is installed on</a></p>${await installations(a)}${FORGET}`;
  }
  if (!(await hubKeySet(a.env)))
    return '<p>The hub key is not set yet. Deploy the hub once (the apply workflow does this), then come back here.</p>';
  return createForm(a);
};

const home = async (a: Admin) =>
  page(
    200,
    nameOf(a.config),
    `<h1>GitHub App</h1>${await bodyFor(a, await findApp(a.env))}`,
    false,
    "'self' https://github.com",
  );

type Conversion = {
  id?: unknown;
  slug?: unknown;
  pem?: unknown;
  html_url?: unknown;
  owner?: { id?: unknown; type?: unknown; login?: unknown };
};

const convert = async (code: string) => {
  const res = await fetch(`${API}/app-manifests/${code}/conversions`, {
    method: 'POST',
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'specreview',
    },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!res || res.status !== 201) return { status: res?.status ?? 0 };
  return { status: 201, app: (await res.json().catch(() => ({}))) as Conversion };
};

const appSettings = (config: HubConfig, slug: string) =>
  `https://github.com/organizations/${encodeURIComponent(config.org)}/settings/apps/${encodeURIComponent(slug)}`;

const created = async (a: Admin) => {
  const code = a.url.searchParams.get('code') ?? '';
  const state = a.url.searchParams.get('state') ?? '';
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(code) || !/^[0-9a-f]{64}$/.test(state))
    return say(
      a,
      400,
      'This link is incomplete',
      "<p>It did not come from GitHub's app creation. Start again from the admin page.</p>",
    );
  // Checked before the state is spent: GitHub's code lasts an hour, so the
  // admin can fix these and open the link again.
  if (!(await hubKeySet(a.env)))
    return say(
      a,
      500,
      'The hub key is not set',
      '<p>GitHub created the app, but the hub has no key to keep it with. Deploy the hub once, then open this link again within the hour.</p>',
    );
  if (envApp(a.env) || (await findApp(a.env)).kind !== 'none')
    return say(
      a,
      409,
      'An app is already set up',
      '<p>Forget the current app on the admin page before adding another. Delete the new one on GitHub if you do not need it.</p>',
    );
  if (!(await takeState(a.env, a.email, state)))
    return say(
      a,
      400,
      'This link has expired',
      '<p>It was already used, is over an hour old, or was started by another admin. Start again from the admin page.</p>',
    );
  const { status, app } = await convert(code);
  if (!app)
    return say(
      a,
      502,
      'GitHub did not hand over the app',
      `<p>GitHub answered ${status || 'nothing'}. If the app was created, delete it on GitHub (your organisation's settings, Developer settings, GitHub Apps) and start again.</p>`,
    );
  const slug = typeof app.slug === 'string' && /^[a-z0-9-]{1,100}$/.test(app.slug) ? app.slug : null;
  const usable = typeof app.id === 'number' && slug && typeof app.pem === 'string' && app.pem.includes('PRIVATE KEY');
  if (!usable)
    return say(a, 502, 'GitHub sent an app the hub cannot use', '<p>Delete it on GitHub and start again.</p>');
  const ours = String(app.owner?.id) === a.config.ownerId && app.owner?.type === 'Organization';
  if (!ours)
    return say(
      a,
      400,
      'The app belongs to another account',
      `<p>${escapeHtml(slug)} was created under ${escapeHtml(String(app.owner?.login ?? 'another account'))}, not ${escapeHtml(a.config.org)}. Delete it on GitHub and create it from this page again.</p>`,
    );
  const saved = await saveApp(a.env, {
    appId: app.id as number,
    slug,
    privateKey: app.pem as string,
    createdBy: a.email,
    createdAt: Date.now(),
  }).catch((err: unknown) => {
    console.error('admin: the GitHub App could not be stored', err instanceof Error ? err.name : typeof err);
    return null;
  });
  // Another admin's return stored an app between the check above and here.
  if (saved === false)
    return say(
      a,
      409,
      'An app is already set up',
      `<p>Another app was stored a moment ago. <a href="${appSettings(a.config, slug)}">Delete ${escapeHtml(slug)} on GitHub</a> if you do not need it.</p>`,
    );
  if (saved === null)
    return say(
      a,
      500,
      'The hub could not keep the app',
      `<p>GitHub created ${escapeHtml(slug)}, but the hub could not store its key, and GitHub gives the key only once. <a href="${appSettings(a.config, slug)}">Delete the app on GitHub</a> and start again.</p>`,
    );
  forgetStoredAuth();
  return new Response(null, { status: 303, headers: { location: '/_admin/', 'cache-control': 'private, no-store' } });
};

// A form on our own page: the browser sends our origin; another site's form
// cannot. Script in a docs site on this origin could (CLAUDE.md, the shared
// origin), as it can reach every other path here.
const forget = async (a: Admin) => {
  if (a.request.headers.get('origin') !== a.url.origin) throw new AppError(403, 'BAD_ORIGIN');
  await forgetApp(a.env);
  forgetStoredAuth();
  return new Response(null, { status: 303, headers: { location: '/_admin/', 'cache-control': 'private, no-store' } });
};

const ROUTES: Record<string, Route> = {
  '/_admin/': { method: 'GET', run: home },
  '/_admin/github/created': { method: 'GET', run: created },
  '/_admin/github/forget': { method: 'POST', run: forget },
};

export const adminRoute = (pathname: string) => (Object.hasOwn(ROUTES, pathname) ? ROUTES[pathname] : null);

export const serveAdmin = async (route: Route, a: Admin): Promise<Response> => {
  if (!a.config.admins.includes(a.email)) throw new AppError(403, 'FORBIDDEN');
  if (a.request.method !== route.method) throw new AppError(405, 'METHOD_NOT_ALLOWED');
  return route.run(a);
};
