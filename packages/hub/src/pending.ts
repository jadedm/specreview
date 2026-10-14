import type { Site } from './config';
import type { Env } from './env';
import { AppError } from './http';

// Removals made on the admin page take effect at once (#12): the site's lists
// less the removals still pending. Read on every request that decides a role;
// if the database cannot say, the request fails rather than letting a removed
// person in.

export type List = 'readers' | 'approvers';
type Row = { list: List; entry: string; removedAt: number };

export const pendingFor = async (env: Env, siteKey: string): Promise<Row[]> => {
  const rows = await env.DB.prepare('SELECT list, entry, removed_at AS removedAt FROM pending_removals WHERE site = ?')
    .bind(siteKey)
    .all<Row>()
    .catch(() => {
      throw new AppError(
        503,
        'DATABASE_UNAVAILABLE',
        'The hub cannot check who may read this right now; try again shortly.',
      );
    });
  return rows.results;
};

export const withPending = async (env: Env, site: Site): Promise<Site> => {
  const rows = await pendingFor(env, site.key);
  if (rows.length === 0) return site;
  const gone = (list: List) => new Set(rows.filter((r) => r.list === list).map((r) => r.entry));
  const readers = gone('readers');
  const approvers = gone('approvers');
  return {
    ...site,
    readers: site.readers.filter((r) => !readers.has(r)),
    approvers: site.approvers.filter((a) => !approvers.has(a)),
  };
};

// A repeat removal always moves the time forward, even within the same
// millisecond, so a page loaded before it cannot clear it (clearPendingAt).
export const addPending = (env: Env, siteKey: string, list: List, entry: string, by: string) =>
  env.DB.prepare(
    'INSERT INTO pending_removals (site, list, entry, removed_by, removed_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET removed_by = excluded.removed_by, removed_at = MAX(excluded.removed_at, pending_removals.removed_at + 1)',
  )
    .bind(siteKey, list, entry, by, Date.now())
    .run();

// The time of an entry's recorded removal: what an admin's action saw when it
// began, so that it clears only that removal (#67). Undefined when there is
// none, null when the database cannot say (then nothing is cleared).
export const pendingAt = async (env: Env, siteKey: string, list: List, entry: string) => {
  const row = await env.DB.prepare('SELECT removed_at FROM pending_removals WHERE site = ? AND list = ? AND entry = ?')
    .bind(siteKey, list, entry)
    .first<{ removed_at: number }>()
    .then((r) => r ?? undefined)
    .catch(() => null);
  return row === null ? null : row?.removed_at;
};

// Clears exactly the removal an admin's action saw (#67): a removal made
// since has a later time (addPending), so it is never cleared, whatever the
// clocks of the machines involved say. True if a row went.
export const clearPendingAt = async (env: Env, siteKey: string, list: List, entry: string, removedAt: number) => {
  const r = await env.DB.prepare(
    'DELETE FROM pending_removals WHERE site = ? AND list = ? AND entry = ? AND removed_at = ?',
  )
    .bind(siteKey, list, entry, removedAt)
    .run();
  return r.meta.changes > 0;
};
