import type { Status } from '../shared/text';
import type { Env } from './env';

export type StatusRow = {
  site: string;
  page: string;
  status: Status;
  version: number;
  ready_hash: string | null;
  changed_by: string;
  changed_at: string;
};

export type Effective = {
  status: Status;
  version: number;
  changedBy: string | null;
  changedAt: string | null;
  // Set when the page was ready but its content has changed since.
  wasReadyAt: string | null;
};

export const readStatusRow = (env: Env, site: string, page: string) =>
  env.DB.prepare('SELECT * FROM page_status WHERE site = ? AND page = ?').bind(site, page).first<StatusRow>();

export const readSiteStatuses = async (env: Env, site: string) =>
  (await env.DB.prepare('SELECT * FROM page_status WHERE site = ?').bind(site).all<StatusRow>()).results;

// Ready belongs to the content that was approved. When the live content hash
// differs, the page counts as in review again, with no write needed.
export const effectiveStatus = (row: StatusRow | null, liveHash: string): Effective => {
  if (!row) return { status: 'pending', version: 0, changedBy: null, changedAt: null, wasReadyAt: null };
  const stale = row.status === 'ready' && row.ready_hash !== liveHash;
  return {
    status: stale ? 'in_review' : row.status,
    version: row.version,
    changedBy: row.changed_by,
    changedAt: row.changed_at,
    wasReadyAt: stale ? row.changed_at : null,
  };
};
