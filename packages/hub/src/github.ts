import { STATUS_LABEL, type Status } from '../shared/text';
import type { HubConfig } from './config';
import type { Ctx, Deps } from './ctx';
import type { Env } from './env';
import type { Purpose } from './github-auth';
import { AppError } from './http';
import { manifestOf } from './manifest';
import { effectiveStatus, readSiteStatuses } from './status-read';

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

const call = async (hub: Hub, repo: string, purpose: Purpose, path: string, init: RequestInit = {}) => {
  const token = await hub.deps.github.tokenFor(repo, purpose);
  if (!token) throw new Error(`no GitHub ${purpose} token for ${repo}`);
  return fetch(`${API}/repos/${repo}${path}`, {
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
  // Only our labels: a private ticket's other labels are not for readers.
  labels: issue.labels.map((l) => l.name).filter((name) => name.startsWith('docs:')),
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
export const ticketsFor = async (ctx: Ctx, issues: number[]) => {
  const now = Date.now();
  return Promise.all(issues.map((n) => fetchTicket(ctx, ctx.site.ticketRepo, n, now)));
};

const ownedLabels = Object.values(STATUS_LABEL);
// A ticket linked from several pages carries the least advanced status among
// them: it is ready to build only when every page that names it is ready.
const RANK: Record<Status, number> = { pending: 0, in_review: 1, ready: 2 };

// Statuses for every ticket of one ticket repo, across every site that files
// tickets there. A site never published links nothing; any other failure to
// read a site makes the whole answer unknown (null), never a guess.
const wantedStatuses = async (hub: Hub, repo: string): Promise<Map<number, Status> | null> => {
  const want = new Map<number, Status>();
  for (const site of hub.config.sites.values()) {
    if (site.ticketRepo !== repo) continue;
    const manifest = await manifestOf(hub.deps.store, site.repo).catch((err: unknown) =>
      err instanceof AppError && err.code === 'SITE_NOT_PUBLISHED' ? 'unpublished' : null,
    );
    if (manifest === null) return null;
    if (manifest === 'unpublished') continue;
    const byPage = new Map((await readSiteStatuses(hub.env, site.repo)).map((r) => [r.page, r]));
    for (const [page, entry] of Object.entries(manifest.pages)) {
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

const ensureLabels = async (hub: Hub, repo: string): Promise<boolean> => {
  if (labelsReady.has(repo)) return true;
  const results = await Promise.all(
    ownedLabels.map(async (name) => {
      const res = await call(hub, repo, 'write', `/labels/${encodeURIComponent(name)}`).catch(() => null);
      if (res?.ok) return true;
      if (res?.status !== 404) return false;
      const made = await call(hub, repo, 'write', '/labels', {
        method: 'POST',
        body: JSON.stringify({
          name,
          color: LABEL_COLOUR[name],
          description: 'Set by specreview from the docs page status',
        }),
      }).catch(() => null);
      if (made?.ok) return true;
      // 422 is also used for validation errors; only "already exists" (someone
      // created it meanwhile) counts as done.
      const body =
        made?.status === 422
          ? ((await made.json().catch(() => null)) as { errors?: { code?: string }[] } | null)
          : null;
      return body?.errors?.some((e) => e.code === 'already_exists') === true;
    }),
  );
  if (results.every(Boolean)) labelsReady.add(repo);
  return results.every(Boolean);
};

// For tests.
export const forgetLabelSetup = () => labelsReady.clear();

const syncTicket = async (hub: Hub, repo: string, n: number, wanted: string): Promise<boolean> => {
  const res = await call(hub, repo, 'write', `/issues/${n}`).catch(() => null);
  if (!res?.ok) return false;
  const issue = (await res.json().catch(() => null)) as Issue | null;
  if (!issue?.labels) return false;
  const have = issue.labels.map((l) => l.name);
  // Add the wanted label before removing the others, so a ticket is never
  // left without one if a removal fails.
  const add = have.includes(wanted)
    ? true
    : await call(hub, repo, 'write', `/issues/${n}/labels`, {
        method: 'POST',
        body: JSON.stringify({ labels: [wanted] }),
      }).then(
        (r) => r.ok,
        () => false,
      );
  if (!add) return false;
  const removals = have
    .filter((name) => ownedLabels.includes(name) && name !== wanted)
    .map((name) =>
      call(hub, repo, 'write', `/issues/${n}/labels/${encodeURIComponent(name)}`, { method: 'DELETE' }).then(
        (r) => r.ok || r.status === 404,
        () => false,
      ),
    );
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
const syncTickets = async (hub: Hub, repo: string, tickets: number[]): Promise<'updated' | 'failed' | 'none'> => {
  if (tickets.length === 0) return 'none';
  const want = await wantedStatuses(hub, repo).catch(() => null);
  if (!want || !(await ensureLabels(hub, repo))) return 'failed';
  const results = await Promise.all(
    tickets.map((n) => syncTicket(hub, repo, n, STATUS_LABEL[want.get(n) ?? 'pending'])),
  );
  return results.every(Boolean) ? 'updated' : 'failed';
};

// After a change on one page: its tickets, with statuses from every site that
// shares the ticket repo.
export const syncSiteLabels = async (ctx: Ctx, page: string) => {
  const manifest = await manifestOf(ctx.deps.store, ctx.site.repo);
  return syncTickets(ctx, ctx.site.ticketRepo, manifest.pages[page]?.issues ?? []);
};

// Every ticket carrying the label, a page of 100 at a time; null if any page
// could not be read, so a partial list is never treated as complete.
const allCarrying = async (hub: Hub, repo: string, label: string): Promise<number[] | null> => {
  const numbers: number[] = [];
  for (let page = 1; page <= 50; page++) {
    const res = await call(
      hub,
      repo,
      'write',
      `/issues?state=all&per_page=100&page=${page}&labels=${encodeURIComponent(label)}`,
    ).catch(() => null);
    if (!res?.ok) return null;
    const body = (await res.json().catch(() => null)) as Issue[] | null;
    if (!Array.isArray(body)) return null;
    numbers.push(...body.map((i) => i.number));
    if (body.length < 100) return numbers;
  }
  // More than 5,000 labelled tickets: the list is incomplete, so say so.
  return null;
};

// Tickets in this repo carrying one of our labels but linked from no page of
// any site lose the label.
const clearUnlinked = async (hub: Hub, repo: string, linked: Set<number>): Promise<boolean> => {
  const results = await Promise.all(
    ownedLabels.map(async (label) => {
      const carrying = await allCarrying(hub, repo, label);
      if (!carrying) return false;
      const removals = carrying
        .filter((n) => !linked.has(n))
        .map((n) =>
          call(hub, repo, 'write', `/issues/${n}/labels/${encodeURIComponent(label)}`, { method: 'DELETE' }).then(
            (r) => r.ok || r.status === 404,
            () => false,
          ),
        );
      return (await Promise.all(removals)).every(Boolean);
    }),
  );
  return results.every(Boolean);
};

const reconcileRepo = async (hub: Hub, repo: string): Promise<'updated' | 'failed' | 'none'> => {
  const linked = new Set<number>();
  for (const site of hub.config.sites.values()) {
    if (site.ticketRepo !== repo) continue;
    const manifest = await manifestOf(hub.deps.store, site.repo).catch((err: unknown) =>
      err instanceof AppError && err.code === 'SITE_NOT_PUBLISHED' ? 'unpublished' : null,
    );
    // Without every site's links, "no page links this ticket" is unknown.
    if (manifest === null) return 'failed';
    if (manifest === 'unpublished') continue;
    for (const entry of Object.values(manifest.pages)) for (const n of entry.issues) linked.add(n);
  }
  const result = await syncTickets(hub, repo, [...linked]);
  const cleared = await clearUnlinked(hub, repo, linked);
  return cleared ? result : 'failed';
};

// Cron: each ticket repo on its own, so one failing repo stops nothing else.
export const reconcileLabels = async (hub: Hub) => {
  const repos = [...new Set([...hub.config.sites.values()].map((s) => s.ticketRepo))];
  const results: Record<string, string> = {};
  for (const repo of repos) results[repo] = await reconcileRepo(hub, repo).catch(() => 'failed');
  const failed = Object.entries(results).filter(([, r]) => r === 'failed');
  if (failed.length > 0) console.error('label sync failed for', failed.map(([r]) => r).join(', '));
  return results;
};
