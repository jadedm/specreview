import type { Site } from './config';
import type { Env } from './env';
import { AppError } from './http';

// Removals made on the admin page take effect at once (#12): the site's lists
// less the removals still pending. Read on every request that decides a role;
// if the database cannot say, the request fails rather than letting a removed
// person in.

export type List = 'readers' | 'approvers';
type Row = { list: List; entry: string };

export const pendingFor = async (env: Env, siteKey: string): Promise<Row[]> => {
  const rows = await env.DB.prepare('SELECT list, entry FROM pending_removals WHERE site = ?')
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

export const addPending = (env: Env, siteKey: string, list: List, entry: string, by: string) =>
  env.DB.prepare(
    'INSERT INTO pending_removals (site, list, entry, removed_by, removed_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET removed_by = excluded.removed_by, removed_at = excluded.removed_at',
  )
    .bind(siteKey, list, entry, by, Date.now())
    .run();

// Clears a removal only if it is older than `ms`: an add that finds the entry
// already listed must not undo a removal another admin's commit is still
// carrying (#12).
export const clearPendingOlderThan = (env: Env, siteKey: string, list: List, entry: string, ms: number) =>
  env.DB.prepare('DELETE FROM pending_removals WHERE site = ? AND list = ? AND entry = ? AND removed_at < ?')
    .bind(siteKey, list, entry, Date.now() - ms)
    .run();

export const clearPending = (env: Env, siteKey: string, list: List, entry: string) =>
  env.DB.prepare('DELETE FROM pending_removals WHERE site = ? AND list = ? AND entry = ?')
    .bind(siteKey, list, entry)
    .run();
