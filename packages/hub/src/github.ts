import { type IssueLink, issueParts, STATUS_LABEL, type Status } from '@specreview/shared';
import type { HubConfig, Site } from './config';
import type { Ctx, Deps } from './ctx';
import type { Env } from './env';
import type { Purpose } from './github-auth';
import { AppError } from './http';
import { snapshotOf, type Snapshot } from './manifest';
import { isTeam, type Role } from './roles';
import { effectiveStatus, readSiteStatuses } from './status-read';
import { API, githubFetch, redirectOf } from './github-fetch';

const ownedLabels: string[] = Object.values(STATUS_LABEL);

export const TICKET_TTL_MS = 5 * 60_000;

type Issue = { number: number; title: string; state: string; html_url: string; labels: { name: string }[] };
export type Ticket =
  | { number: number; title: string; state: string; url: string; labels: string[]; fetchedAt: string; stale: boolean }
  | { number: number; unavailable: true }
  | { number: number; notFound: true }
  // A link to a repo the site no longer lists (#90): nothing is fetched.
  | { number: number; notLinked: true };

// A page's ticket link as `<org>/<repo>` and number (#90): a bare number is in
// the site's default ticket repo; null for a repo the site does not list (its
// config changed after the build was published) or a malformed link.
export const resolveLink = (site: Site, org: string, link: IssueLink) => {
  const parts = issueParts(link);
  const repo = parts && (parts.repo === null ? site.ticketRepo : `${org}/${parts.repo}`);
  return parts && repo && site.ticketRepos.includes(repo) ? { repo, number: parts.number } : null;
};
// The numbers of a page's links that are in one ticket repo.
const numbersIn = (site: Site, org: string, issues: IssueLink[], repo: string) =>
  issues.flatMap((link) => {
    const r = resolveLink(site, org, link);
    return r && r.repo === repo ? [r.number] : [];
  });

// Everything that talks to GitHub needs the database, the auth and the config;
// requests and the cron both have these.
type Hub = { env: Env; deps: Deps; config: HubConfig };

class NoToken extends Error {}

const send = (token: string, repo: string, path: string, init: RequestInit) =>
  githubFetch(`${API}/repos/${repo}${path}`, {
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
  // A redirect's message says what happened; it was not GitHub's error.
  const hint = redirectOf(res) ? undefined : hintFor(res.status, path);
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
// A site with several ticket repos (#90) names each ticket's repo, bare.
export const ticketsFor = async (ctx: Ctx, issues: IssueLink[], role: Role) => {
  const now = Date.now();
  const several = ctx.site.ticketRepos.length > 1;
  const tickets = await Promise.all(
    issues.map(async (link): Promise<Ticket & { repo?: string }> => {
      const parts = issueParts(link);
      const r = resolveLink(ctx.site, ctx.config.org, link);
      const repo = several ? { repo: parts?.repo ?? ctx.site.ticketRepo.split('/')[1] } : {};
      // A link to an unlisted repo names it on any site, so #4 is never read as the default's.
      if (!r)
        return { number: parts?.number ?? 0, notLinked: true, repo: parts?.repo ?? ctx.site.ticketRepo.split('/')[1] };
      return { ...(await fetchTicket(ctx, r.repo, r.number, now)), ...repo };
    }),
  );
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
    if (!site.ticketRepos.includes(repo)) continue;
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

const siteByKey = (hub: Hub, key: string) => [...hub.config.sites.values()].find((s) => s.key === key) as Site;

// Statuses for every ticket of one ticket repo, across the given snapshots;
// only the links that resolve to this repo count (#90).
const wantedStatuses = async (hub: Hub, repo: string, snaps: Snapshots): Promise<Map<number, Status>> => {
  const want = new Map<number, Status>();
  for (const [key, snap] of snaps) {
    const site = siteByKey(hub, key);
    const byPage = new Map((await readSiteStatuses(hub.env, key)).map((r) => [r.page, r]));
    for (const [page, entry] of Object.entries(snap.manifest.pages)) {
      const status = effectiveStatus(byPage.get(page) ?? null, entry.hash).status;
      for (const n of numbersIn(site, hub.config.org, entry.issues, repo)) {
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

// Recorded before any label is written in a repo (#155), so the cron can clear
// our labels there once no site lists it. Without the record nothing is
// written: a label the hub does not know it set could never be cleared. A sync
// records again after its writes, so a clearing that began while they were in
// flight keeps the repo for its next run.
const recordRepo = (hub: Hub, repo: string, problems: Problems) =>
  hub.env.DB.prepare(
    `INSERT INTO label_repos (repo, labelled_at) VALUES (?, ?)
     ON CONFLICT (repo) DO UPDATE SET labelled_at = excluded.labelled_at, failing_since = NULL`,
  )
    .bind(repo, Date.now())
    .run()
    .then(
      () => true,
      (err: unknown) => {
        problems.push(`recording ${repo} as labelled failed (${errorText(err)})`);
        return false;
      },
    );

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
  const want = await wantedStatuses(hub, repo, snaps).catch((err: unknown) => {
    problems.push(`reading page statuses failed (${errorText(err)})`);
    return null;
  });
  if (!want || !(await recordRepo(hub, repo, problems)) || !(await ensureLabels(hub, repo, problems))) return 'failed';
  const results = await Promise.all(
    tickets.map((n) => syncTicket(hub, repo, n, STATUS_LABEL[want.get(n) ?? 'pending'], problems)),
  );
  const recorded = await recordRepo(hub, repo, problems);
  return recorded && results.every(Boolean) ? 'updated' : 'failed';
};

// Each ticket repo the page's links resolve to, on its own (#90).
const syncPage = async (ctx: Ctx, page: string, problems: Problems) => {
  const own = await ctx.snapshot();
  const issues = own.manifest.pages[page]?.issues ?? [];
  const results = await Promise.all(
    ctx.site.ticketRepos.map(async (repo) => {
      const numbers = numbersIn(ctx.site, ctx.config.org, issues, repo);
      if (numbers.length === 0) return 'none' as const;
      const snaps = await snapshotsFor(ctx, repo, problems, new Map([[ctx.site.key, own]]));
      return snaps ? syncTickets(ctx, repo, numbers, snaps, problems) : ('failed' as const);
    }),
  );
  if (results.includes('failed')) return 'failed';
  return results.includes('updated') ? 'updated' : 'none';
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
      `label sync failed for ${ctx.site.ticketRepos.join(', ')} after a change to ${ctx.site.key} ${page}: ${summary(problems)}`,
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
  // Every listed repo is recorded, whether or not a page links it now: labels
  // it holds from before #155 are then cleared if it is dropped before they go,
  // and an earlier failure to clear it is forgotten while it is listed.
  if (!(await recordRepo(hub, repo, problems))) return 'failed';
  const snaps = await snapshotsFor(hub, repo, problems);
  // Without every site's links, "no page links this ticket" is unknown.
  if (!snaps) return 'failed';
  const linked = new Set<number>();
  for (const [key, snap] of snaps) {
    const site = siteByKey(hub, key);
    for (const entry of Object.values(snap.manifest.pages))
      for (const n of numbersIn(site, hub.config.org, entry.issues, repo)) linked.add(n);
  }
  const result = await syncTickets(hub, repo, [...linked], snaps, problems);
  const cleared = await clearUnlinked(hub, repo, linked, problems);
  return cleared ? result : 'failed';
};

const GIVE_UP_MS = 7 * 24 * 60 * 60_000;
type Recorded = { repo: string; failing_since: number | null };

// A recorded repo no site lists any more (#155): no page link resolves to it
// (resolveLink), so every one of our labels there goes. The repo is forgotten
// once clear, unless it was recorded after the clearing began (an isolate
// still holding a config that lists it, finishing its writes). One that keeps failing (the
// app uninstalled, the repo deleted) is forgotten after a week, with a line
// saying its labels are left for a person.
const clearDropped = async (hub: Hub, row: Recorded, problems: Problems): Promise<'cleared' | 'failed'> => {
  const started = Date.now();
  if (await clearUnlinked(hub, row.repo, new Set(), problems)) {
    await hub.env.DB.prepare('DELETE FROM label_repos WHERE repo = ? AND labelled_at < ?')
      .bind(row.repo, started)
      .run();
    return 'cleared';
  }
  if (row.failing_since === null) {
    await hub.env.DB.prepare('UPDATE label_repos SET failing_since = ? WHERE repo = ? AND failing_since IS NULL')
      .bind(started, row.repo)
      .run();
    return 'failed';
  }
  if (started - row.failing_since <= GIVE_UP_MS) return 'failed';
  const gone = await hub.env.DB.prepare(
    'DELETE FROM label_repos WHERE repo = ? AND failing_since = ? AND labelled_at < ?',
  )
    .bind(row.repo, row.failing_since, started)
    .run();
  // Recorded again meanwhile: kept, and the next run tries afresh.
  if (gone.meta.changes === 0) return 'failed';
  problems.unshift('no site lists it and clearing has failed for over 7 days; forgotten, remove its labels by hand');
  return 'failed';
};

const recordedRepos = (hub: Hub) =>
  hub.env.DB.prepare('SELECT repo, failing_since FROM label_repos')
    .all<Recorded>()
    .then(
      (r) => r.results,
      (err: unknown) => {
        console.error(`label sync could not read the repos it has labelled: ${errorText(err)}`);
        return [] as Recorded[];
      },
    );

// Cron: each ticket repo on its own, so one failing repo stops nothing else;
// the listed ones first, then those no site lists any more.
export const reconcileLabels = async (hub: Hub) => {
  const listed = [...new Set([...hub.config.sites.values()].flatMap((s) => s.ticketRepos))];
  const results: Record<string, string> = {};
  const run = async (repo: string, step: (problems: Problems) => Promise<string>) => {
    const problems: Problems = [];
    results[repo] = await step(problems).catch((err: unknown) => {
      problems.push(`unexpected error (${errorText(err)})`);
      return 'failed';
    });
    if (results[repo] === 'failed') console.error(`label sync failed for ${repo}: ${summary(problems)}`);
  };
  for (const repo of listed) await run(repo, (problems) => reconcileRepo(hub, repo, problems));
  for (const row of await recordedRepos(hub)) {
    if (listed.includes(row.repo)) continue;
    await run(row.repo, (problems) => clearDropped(hub, row, problems));
  }
  return results;
};
