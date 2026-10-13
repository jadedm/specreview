import { STATUS_LABEL, type Status } from '@specreview/shared';
import type { HubConfig } from './config';
import type { Ctx, Deps } from './ctx';
import type { Env } from './env';
import type { Purpose } from './github-auth';
import { AppError } from './http';
import { snapshotOf, type Snapshot } from './manifest';
import { isTeam, type Role } from './roles';
import { effectiveStatus, readSiteStatuses } from './status-read';

const ownedLabels: string[] = Object.values(STATUS_LABEL);

const API = 'https://api.github.com';
export const TICKET_TTL_MS = 5 * 60_000;

type Issue = { number: number; title: string; state: string; html_url: string; labels: { name: string }[] };
export type Ticket =
  | { number: number; title: string; state: string; url: string; labels: string[]; fetchedAt: string; stale: boolean }
  | { number: number; unavailable: true }
  | { number: number; notFound: true };

// Everything that talks to GitHub needs the database, the auth and the config;
// requests and the cron both have these.
type Hub = { env: Env; deps: Deps; config: HubConfig };

class NoToken extends Error {}

const send = (token: string, repo: string, path: string, init: RequestInit) =>
  fetch(`${API}/repos/${repo}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'specreview',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
    signal: AbortSignal.timeout(5_000),
  });

// A 401 means the token was revoked or expired early: drop it and try once
// more with a new one. A second 401 is GitHub's answer.
const call = async (hub: Hub, repo: string, purpose: Purpose, path: string, init: RequestInit = {}) => {
  const auth = hub.deps.github;
  const token = await auth.tokenFor(repo, purpose);
  if (!token) throw new NoToken(`no GitHub ${purpose} token for ${repo}`);
  const res = await send(token, repo, path, init);
  if (res.status !== 401 || !auth.invalidate) return res;
  auth.invalidate(repo, purpose);
  const again = await auth.tokenFor(repo, purpose);
  if (!again || again === token) return res;
  await res.body?.cancel();
  return send(again, repo, path, init);
};

// Why a sync failed, for the one log line an operator gets from it: the step
// and GitHub's answer. Never the token, and of a response body only GitHub's
// own JSON message.
type Problems = string[];

const errorName = (err: unknown) => (err instanceof Error ? err.name : typeof err);
// For errors that are not GitHub's answer (the database, the store, a bug):
// the hub's own code, or the error's message cut short.
const errorText = (err: unknown) => {
  if (err instanceof AppError) return err.code;
  if (!(err instanceof Error)) return typeof err;
  return `${err.name}: ${err.message.replace(/\s+/g, ' ').trim().slice(0, 200)}`;
};

const HINT: Record<number, string> = {
  401: 'the token is invalid or expired',
  403: 'the token lacks permission or hit a rate limit',
  422: 'GitHub refused the request',
};
// GitHub answers 404 for a repo the token cannot see, so a 404 on a repo-wide
// path means that; on one ticket it may also mean the ticket is gone.
const hintFor = (status: number, path: string): string | undefined => {
  if (status === 404) {
    return path.startsWith('/issues/')
      ? 'no such ticket, or the token cannot see the repo'
      : 'the token cannot see the repo';
  }
  if (status >= 500) return 'GitHub had an error';
  return HINT[status];
};

const githubMessage = async (res: Response) => {
  if (!res.headers.get('content-type')?.includes('json')) return '';
  const body = (await res.json().catch(() => null)) as { message?: unknown } | null;
  if (typeof body?.message !== 'string') return '';
  return body.message.replace(/\s+/g, ' ').trim().slice(0, 200);
};

// A request whose answer was not what the step needed; always false.
const failed = async (problems: Problems, method: string, path: string, res: Response) => {
  const message = await githubMessage(res);
  const hint = hintFor(res.status, path);
  problems.push(`${method} ${path} -> ${res.status}${message ? ` ${message}` : ''}${hint ? ` (${hint})` : ''}`);
  return false;
};

// One GitHub request for a sync; null, with the reason noted, when there was
// no token or no answer.
const attempt = (hub: Hub, repo: string, path: string, problems: Problems, init: RequestInit = {}) =>
  call(hub, repo, 'write', path, init).catch((err: unknown) => {
    problems.push(
      err instanceof NoToken ? err.message : `${init.method ?? 'GET'} ${path} -> no response (${errorName(err)})`,
    );
    return null;
  });

const summary = (problems: Problems) => {
  const [first = 'no reason recorded'] = problems;
  return problems.length > 1 ? `${first} (and ${problems.length - 1} more)` : first;
};

type Cached = { data: string; fetched_at: number };

// Only what the page shows is kept; an issue's body and author are not.
const slim = (issue: Issue): Issue => ({
  number: issue.number,
  title: issue.title,
  state: issue.state,
  html_url: issue.html_url,
  labels: issue.labels.map((l) => ({ name: l.name })),
});

const fromIssue = (issue: Issue, fetchedAt: number, stale: boolean): Ticket => ({
  number: issue.number,
  title: issue.title,
  state: issue.state,
  url: issue.html_url,
  // Only our three labels: a private ticket's other labels, or a label that
  // merely starts with "docs:", are free text and not for readers.
  labels: issue.labels.map((l) => l.name).filter((name) => ownedLabels.includes(name)),
  fetchedAt: new Date(fetchedAt).toISOString(),
  stale,
});

const fetchTicket = async (hub: Hub, repo: string, n: number, now: number): Promise<Ticket> => {
  const cached = await hub.env.DB.prepare('SELECT data, fetched_at FROM ticket_cache WHERE repo = ? AND number = ?')
    .bind(repo, n)
    .first<Cached>();
  if (cached && now - cached.fetched_at < TICKET_TTL_MS) {
    return fromIssue(JSON.parse(cached.data) as Issue, cached.fetched_at, false);
  }
  const res = await call(hub, repo, 'read', `/issues/${n}`).catch(() => null);
  if (res?.status === 404) return { number: n, notFound: true };
  const issue = res?.ok ? ((await res.json().catch(() => null)) as Issue | null) : null;
  if (issue?.labels) {
    await hub.env.DB.prepare(
      `INSERT INTO ticket_cache (repo, number, data, fetched_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (repo, number) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`,
    )
      .bind(repo, n, JSON.stringify(slim(issue)), now)
      .run();
    return fromIssue(issue, now, false);
  }
  // GitHub is down, refused, or there is no token: say so, with the last copy
  // if there is one.
  if (cached) return fromIssue(JSON.parse(cached.data) as Issue, cached.fetched_at, true);
  return { number: n, unavailable: true };
};

// Only tickets the build linked to this page, in the site's own ticket repo.
// A reader gets the number, state and our label: titles and links are the
// team's.
export const ticketsFor = async (ctx: Ctx, issues: number[], role: Role) => {
  const now = Date.now();
  const tickets = await Promise.all(issues.map((n) => fetchTicket(ctx, ctx.site.ticketRepo, n, now)));
  if (isTeam(role)) return tickets;
  return tickets.map((t) => {
    if (!('title' in t)) return t;
    const { title: _title, url: _url, ...rest } = t;
    return rest;
  });
};
// A ticket linked from several pages carries the least advanced status among
// them: it is ready to build only when every page that names it is ready.
const RANK: Record<Status, number> = { pending: 0, in_review: 1, ready: 2 };

// One snapshot per site that files tickets in this repo, read once and used
// for every decision of a sync, so link collection and statuses never come
// from two different publishes. A site never published links nothing; a site
// whose pointer or manifest is broken makes the whole answer unknown (null),
// never a guess. `known` passes in snapshots the caller already holds.
type Snapshots = Map<string, Snapshot>;
const snapshotsFor = async (
  hub: Hub,
  repo: string,
  problems: Problems,
  known: Snapshots = new Map(),
): Promise<Snapshots | null> => {
  const snaps: Snapshots = new Map();
  for (const site of hub.config.sites.values()) {
    if (site.ticketRepo !== repo) continue;
    const held = known.get(site.key);
    const snap =
      held ??
      (await snapshotOf(hub.deps.store, site.repo).catch((err: unknown) => {
        if (err instanceof AppError && err.code === 'SITE_NOT_PUBLISHED') return 'unpublished' as const;
        const why = err instanceof AppError ? err.code : errorName(err);
        problems.push(`site ${site.key}: its published version cannot be read (${why})`);
        return null;
      }));
    if (snap === null) return null;
    if (snap !== 'unpublished') snaps.set(site.key, snap);
  }
  return snaps;
};

// Statuses for every ticket of one ticket repo, across the given snapshots.
const wantedStatuses = async (hub: Hub, snaps: Snapshots): Promise<Map<number, Status>> => {
  const want = new Map<number, Status>();
  for (const [key, snap] of snaps) {
    const byPage = new Map((await readSiteStatuses(hub.env, key)).map((r) => [r.page, r]));
    for (const [page, entry] of Object.entries(snap.manifest.pages)) {
      const status = effectiveStatus(byPage.get(page) ?? null, entry.hash).status;
      for (const n of entry.issues) {
        const current = want.get(n);
        if (current === undefined || RANK[status] < RANK[current]) want.set(n, status);
      }
    }
  }
  return want;
};

// Our three labels are created in a repo the first time they are needed
// (once per isolate), so a fresh repo needs no manual setup.
const LABEL_COLOUR: Record<string, string> = {
  [STATUS_LABEL.pending]: 'cfd3d7',
  [STATUS_LABEL.in_review]: 'fbca04',
  [STATUS_LABEL.ready]: '0e8a16',
};
const labelsReady = new Set<string>();

// 422 is also used for validation errors; only "already exists" (someone
// created it meanwhile) counts as done.
const alreadyExists = async (res: Response) => {
  if (res.status !== 422) return false;
  const body = (await res.json().catch(() => null)) as { errors?: { code?: string }[] } | null;
  return body?.errors?.some((e) => e.code === 'already_exists') === true;
};

const ensureLabels = async (hub: Hub, repo: string, problems: Problems): Promise<boolean> => {
  if (labelsReady.has(repo)) return true;
  const results = await Promise.all(
    ownedLabels.map(async (name) => {
      const path = `/labels/${encodeURIComponent(name)}`;
      const res = await attempt(hub, repo, path, problems);
      if (!res) return false;
      if (res.ok) return true;
      if (res.status !== 404) return failed(problems, 'GET', path, res);
      const made = await attempt(hub, repo, '/labels', problems, {
        method: 'POST',
        body: JSON.stringify({
          name,
          color: LABEL_COLOUR[name],
          description: 'Set by specreview from the docs page status',
        }),
      });
      if (!made) return false;
      if (made.ok || (await alreadyExists(made.clone()))) return true;
      return failed(problems, 'POST', '/labels', made);
    }),
  );
  if (results.every(Boolean)) labelsReady.add(repo);
  return results.every(Boolean);
};

// For tests.
export const forgetLabelSetup = () => labelsReady.clear();

// A label removal answered 404 is already done.
const removeLabel = async (hub: Hub, repo: string, n: number, name: string, problems: Problems) => {
  const path = `/issues/${n}/labels/${encodeURIComponent(name)}`;
  const res = await attempt(hub, repo, path, problems, { method: 'DELETE' });
  if (!res) return false;
  if (res.ok || res.status === 404) return true;
  return failed(problems, 'DELETE', path, res);
};

const addLabel = async (hub: Hub, repo: string, n: number, name: string, problems: Problems) => {
  const path = `/issues/${n}/labels`;
  const res = await attempt(hub, repo, path, problems, { method: 'POST', body: JSON.stringify({ labels: [name] }) });
  if (!res) return false;
  return res.ok || failed(problems, 'POST', path, res);
};

const syncTicket = async (hub: Hub, repo: string, n: number, wanted: string, problems: Problems): Promise<boolean> => {
  const path = `/issues/${n}`;
  const res = await attempt(hub, repo, path, problems);
  if (!res) return false;
  if (!res.ok) return failed(problems, 'GET', path, res);
  const issue = (await res.json().catch(() => null)) as Issue | null;
  if (!issue?.labels) {
    problems.push(`GET ${path} -> ${res.status} with no labels in the answer`);
    return false;
  }
  const have = issue.labels.map((l) => l.name);
  // Add the wanted label before removing the others, so a ticket is never
  // left without one if a removal fails.
  const add = have.includes(wanted) || (await addLabel(hub, repo, n, wanted, problems));
  if (!add) return false;
  const removals = have
    .filter((name) => ownedLabels.includes(name) && name !== wanted)
    .map((name) => removeLabel(hub, repo, n, name, problems));
  const removed = (await Promise.all(removals)).every(Boolean);
  // Only when a label actually changed: mark the cached copy as expired, so the
  // ticket box refetches instead of showing the old label as fresh, while the
  // copy stays available as the stale fallback if GitHub is down.
  const changed = !have.includes(wanted) || removals.length > 0;
  if (changed) {
    await hub.env.DB.prepare('UPDATE ticket_cache SET fetched_at = 0 WHERE repo = ? AND number = ?')
      .bind(repo, n)
      .run();
  }
  return removed;
};

// Sets each ticket's label from the statuses read at the start of the sync.
// Two syncs that overlap on a shared ticket can still leave the older label
// or two labels for a moment; the cron below puts it right within 5 minutes.
const syncTickets = async (
  hub: Hub,
  repo: string,
  tickets: number[],
  snaps: Snapshots,
  problems: Problems,
): Promise<'updated' | 'failed' | 'none'> => {
  if (tickets.length === 0) return 'none';
  const want = await wantedStatuses(hub, snaps).catch((err: unknown) => {
    problems.push(`reading page statuses failed (${errorText(err)})`);
    return null;
  });
  if (!want || !(await ensureLabels(hub, repo, problems))) return 'failed';
  const results = await Promise.all(
    tickets.map((n) => syncTicket(hub, repo, n, STATUS_LABEL[want.get(n) ?? 'pending'], problems)),
  );
  return results.every(Boolean) ? 'updated' : 'failed';
};

const syncPage = async (ctx: Ctx, page: string, problems: Problems) => {
  const own = await ctx.snapshot();
  const snaps = await snapshotsFor(ctx, ctx.site.ticketRepo, problems, new Map([[ctx.site.key, own]]));
  if (!snaps) return 'failed';
  return syncTickets(ctx, ctx.site.ticketRepo, own.manifest.pages[page]?.issues ?? [], snaps, problems);
};

// After a change on one page: its tickets, with statuses from every site that
// shares the ticket repo. Never throws; a failure is logged with its reason and
// repaired by the cron.
export const syncSiteLabels = async (ctx: Ctx, page: string) => {
  const problems: Problems = [];
  const result = await syncPage(ctx, page, problems).catch((err: unknown) => {
    problems.push(`unexpected error (${errorText(err)})`);
    return 'failed' as const;
  });
  if (result === 'failed') {
    console.error(
      `label sync failed for ${ctx.site.ticketRepo} after a change to ${ctx.site.key} ${page}: ${summary(problems)}`,
    );
  }
  return result;
};

// Every ticket carrying the label, a page of 100 at a time; null if any page
// could not be read, so a partial list is never treated as complete.
const allCarrying = async (hub: Hub, repo: string, label: string, problems: Problems): Promise<number[] | null> => {
  const numbers: number[] = [];
  for (let page = 1; page <= 50; page++) {
    const path = `/issues?state=all&per_page=100&page=${page}&labels=${encodeURIComponent(label)}`;
    const res = await attempt(hub, repo, path, problems);
    if (!res) return null;
    if (!res.ok) return failed(problems, 'GET', path, res).then(() => null);
    const body = (await res.json().catch(() => null)) as Issue[] | null;
    if (!Array.isArray(body)) {
      problems.push(`GET ${path} -> ${res.status} with no list in the answer`);
      return null;
    }
    numbers.push(...body.map((i) => i.number));
    if (body.length < 100) return numbers;
  }
  // More than 5,000 labelled tickets: the list is incomplete, so say so.
  problems.push(`more than 5,000 tickets carry ${label}; the list is incomplete`);
  return null;
};

// Tickets in this repo carrying one of our labels but linked from no page of
// any site lose the label.
const clearUnlinked = async (hub: Hub, repo: string, linked: Set<number>, problems: Problems): Promise<boolean> => {
  const results = await Promise.all(
    ownedLabels.map(async (label) => {
      const carrying = await allCarrying(hub, repo, label, problems);
      if (!carrying) return false;
      const removals = carrying.filter((n) => !linked.has(n)).map((n) => removeLabel(hub, repo, n, label, problems));
      return (await Promise.all(removals)).every(Boolean);
    }),
  );
  return results.every(Boolean);
};

const reconcileRepo = async (hub: Hub, repo: string, problems: Problems): Promise<'updated' | 'failed' | 'none'> => {
  const snaps = await snapshotsFor(hub, repo, problems);
  // Without every site's links, "no page links this ticket" is unknown.
  if (!snaps) return 'failed';
  const linked = new Set<number>();
  for (const snap of snaps.values())
    for (const entry of Object.values(snap.manifest.pages)) for (const n of entry.issues) linked.add(n);
  const result = await syncTickets(hub, repo, [...linked], snaps, problems);
  const cleared = await clearUnlinked(hub, repo, linked, problems);
  return cleared ? result : 'failed';
};

// Cron: each ticket repo on its own, so one failing repo stops nothing else.
export const reconcileLabels = async (hub: Hub) => {
  const repos = [...new Set([...hub.config.sites.values()].map((s) => s.ticketRepo))];
  const results: Record<string, string> = {};
  for (const repo of repos) {
    const problems: Problems = [];
    results[repo] = await reconcileRepo(hub, repo, problems).catch((err: unknown) => {
      problems.push(`unexpected error (${errorText(err)})`);
      return 'failed' as const;
    });
    if (results[repo] === 'failed') console.error(`label sync failed for ${repo}: ${summary(problems)}`);
  }
  return results;
};
