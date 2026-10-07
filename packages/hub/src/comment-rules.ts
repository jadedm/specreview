// Caps, shared SQL fragments and row types for comments (comments.ts).
// Every fragment filters by site first: one site's threads never count,
// block or demote anything on another.
import { type Ctx, siteKey } from './ctx';
import { syncSiteLabels } from './github';

// Open threads are capped when written and always all listed: an unlisted
// open thread would block ready with nothing anyone could resolve. Only open
// threads count, so resolving frees room and no one can close a page to
// comments for good; one author can hold at most a tenth of the room.
// Resolved threads are listed newest first up to RESOLVED_LISTED.
export const MAX_OPEN_THREADS_PER_PAGE = 200;
export const MAX_OPEN_THREADS_PER_AUTHOR = 20;
export const RESOLVED_LISTED = 300;
// Replies are capped per thread and per author in a thread, so one person
// cannot fill a thread for everyone.
export const MAX_REPLIES_PER_THREAD = 200;
export const MAX_REPLIES_PER_AUTHOR = 20;

// Bind order for each: site, page[, author].
export const OPEN_ON_PAGE = `(SELECT count(*) FROM threads WHERE site = ? AND page = ? AND state = 'open')`;
export const OPEN_BY_AUTHOR = `(SELECT count(*) FROM threads WHERE site = ? AND page = ? AND author = ? AND state = 'open')`;

// A label sync failure is repaired by the cron; the log line makes a GitHub
// token that keeps failing visible instead of silent.
export const syncLogged = (ctx: Ctx, page: string) =>
  syncSiteLabels(ctx, page).catch((err: unknown) => {
    console.error(
      'label sync after a comment failed',
      siteKey(ctx),
      page,
      err instanceof Error ? err.message : String(err),
    );
    return 'failed' as const;
  });

// An open comment and a ready page cannot coexist: posting or reopening one
// on a ready page moves it back to in review, in the same batch, so the
// ready write (which requires no open thread) and this cannot interleave.
// The open-thread condition is a second line of defence: a refused insert or
// reopen leaves no new open thread, so the page stays as it was.
export const demoteIfReady = (ctx: Ctx, page: string, email: string, at: string, pageHash: string) => {
  const site = siteKey(ctx);
  return [
    ctx.env.DB.prepare(
      `UPDATE page_status SET status = 'in_review', version = version + 1, ready_hash = NULL,
         changed_by = ?, changed_at = ?
       WHERE site = ? AND page = ? AND status = 'ready'
         AND EXISTS (SELECT 1 FROM threads WHERE site = ? AND page = ? AND state = 'open')`,
    ).bind(email, at, site, page, site, page),
    ctx.env.DB.prepare(
      `INSERT INTO status_history (site, id, page, status, version, page_hash, changed_by, changed_at)
       SELECT site, ?, page, status, version, ?, changed_by, changed_at FROM page_status
       WHERE site = ? AND page = ? AND status = 'in_review' AND changed_by = ? AND changed_at = ?`,
    ).bind(crypto.randomUUID(), pageHash, site, page, email, at),
  ];
};

export type ThreadRow = {
  site: string;
  id: string;
  page: string;
  heading: string;
  quote: string;
  prefix: string;
  suffix: string;
  page_hash: string;
  author: string;
  body: string;
  state: 'open' | 'resolved';
  resolved_by: string | null;
  resolved_pr: number | null;
  resolved_at: string | null;
  created_at: string;
};
export type ReplyRow = { id: string; thread_id: string; author: string; body: string; created_at: string };

export const BODY = { kind: 'string', max: 5_000, multiline: true } as const;
