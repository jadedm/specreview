import { quoteIn } from '../shared/text';
import {
  BODY,
  demoteIfReady,
  MAX_OPEN_THREADS_PER_AUTHOR,
  MAX_OPEN_THREADS_PER_PAGE,
  MAX_REPLIES_PER_AUTHOR,
  MAX_REPLIES_PER_THREAD,
  OPEN_BY_AUTHOR,
  OPEN_ON_PAGE,
  RESOLVED_LISTED,
  type ReplyRow,
  syncLogged,
  type ThreadRow,
} from './comment-rules';
import { type Ctx, siteKey } from './ctx';
import { AppError } from './http';
import { pageOf } from './manifest';
import { recordWrite } from './rate-limit';
import { isTeam, type Role } from './roles';
import { parseBody } from './validate';

const db = (ctx: Ctx) => ctx.env.DB;

// Outdated threads quote text the page no longer has. Readers do not get that
// text, for the same reason old versions are team-only: it may have been
// removed before they were given access.
export const listComments = async (ctx: Ctx, page: string, role: Role) => {
  const site = siteKey(ctx);
  const current = await pageOf(ctx.deps.store, site, page);
  const [open, resolved] = await db(ctx).batch<ThreadRow>([
    db(ctx)
      .prepare(`SELECT * FROM threads WHERE site = ? AND page = ? AND state = 'open' ORDER BY created_at, id LIMIT ?`)
      .bind(site, page, MAX_OPEN_THREADS_PER_PAGE),
    db(ctx)
      .prepare(
        `SELECT * FROM threads WHERE site = ? AND page = ? AND state = 'resolved' ORDER BY resolved_at DESC, id LIMIT ?`,
      )
      .bind(site, page, RESOLVED_LISTED),
  ]);
  const listed = [...open.results, ...resolved.results].sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
  );
  // Replies of the listed threads only: open ones, and the resolved ones listed.
  const replies = await db(ctx)
    .prepare(
      `SELECT r.* FROM replies r JOIN threads t ON t.site = r.site AND t.id = r.thread_id
       WHERE r.site = ? AND t.page = ? AND (t.state = 'open' OR t.id IN (
         SELECT id FROM threads WHERE site = ? AND page = ? AND state = 'resolved'
         ORDER BY resolved_at DESC, id LIMIT ?))
       ORDER BY r.created_at, r.id`,
    )
    .bind(site, page, site, page, RESOLVED_LISTED)
    .all<ReplyRow>();
  const byThread = Map.groupBy(replies.results, (r) => r.thread_id);
  // Outdated: the quoted text is no longer in its section on the live page.
  const sectionText = new Map(current.sections.map((s) => [s.id, s.text]));
  return listed.map((t) => {
    const outdated = !quoteIn(t.quote, sectionText.get(t.heading) ?? '');
    const hide = outdated && !isTeam(role);
    return {
      id: t.id,
      // A deleted section's id is a slug of its removed heading text.
      heading: hide && !sectionText.has(t.heading) ? '' : t.heading,
      quote: hide ? '' : t.quote,
      quoteHidden: hide,
      prefix: hide ? '' : t.prefix,
      suffix: hide ? '' : t.suffix,
      pageHash: t.page_hash,
      author: t.author,
      body: t.body,
      state: t.state,
      resolvedBy: t.resolved_by,
      resolvedPr: t.resolved_pr,
      resolvedAt: t.resolved_at,
      createdAt: t.created_at,
      outdated,
      replies: (byThread.get(t.id) ?? []).map((r) => ({
        id: r.id,
        author: r.author,
        body: r.body,
        createdAt: r.created_at,
      })),
    };
  });
};

export const createComment = async (ctx: Ctx, email: string, raw: unknown) => {
  const input = parseBody(raw, {
    page: { kind: 'string', max: 200 },
    heading: { kind: 'string', max: 200 },
    quote: { kind: 'string', max: 1_000, multiline: true },
    prefix: { kind: 'string', max: 200, min: 0, multiline: true, optional: true },
    suffix: { kind: 'string', max: 200, min: 0, multiline: true, optional: true },
    body: BODY,
  });
  const site = siteKey(ctx);
  const page = await pageOf(ctx.deps.store, site, input.page);
  const section = page.sections.find((s) => s.id === input.heading);
  if (!section) throw new AppError(400, 'UNKNOWN_HEADING');
  if (!quoteIn(input.quote, section.text)) throw new AppError(400, 'QUOTE_NOT_IN_SECTION');
  const now = Date.now();
  await recordWrite(ctx, email, now);
  const id = crypto.randomUUID();
  const at = new Date(now).toISOString();
  const insert = db(ctx)
    .prepare(
      `INSERT INTO threads (site, id, page, heading, quote, prefix, suffix, page_hash, author, body, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE ${OPEN_ON_PAGE} < ? AND ${OPEN_BY_AUTHOR} < ?`,
    )
    .bind(
      site,
      id,
      input.page,
      input.heading,
      input.quote,
      input.prefix ?? '',
      input.suffix ?? '',
      page.hash,
      email,
      input.body,
      at,
      site,
      input.page,
      MAX_OPEN_THREADS_PER_PAGE,
      site,
      input.page,
      email,
      MAX_OPEN_THREADS_PER_AUTHOR,
    );
  const [inserted, demoted] = await db(ctx).batch([insert, ...demoteIfReady(ctx, input.page, email, at, page.hash)]);
  if (inserted.meta.changes === 0) throw await whyRefused(ctx, input.page, email);
  if (demoted.meta.changes > 0) await syncLogged(ctx, input.page);
  return { id };
};

const whyRefused = async (ctx: Ctx, page: string, email: string, caller = email) => {
  const mine = await db(ctx)
    .prepare(`SELECT count(*) AS n FROM threads WHERE site = ? AND page = ? AND author = ? AND state = 'open'`)
    .bind(siteKey(ctx), page, email)
    .first<{ n: number }>();
  const theirs = caller === email ? 'You have' : 'Its author has';
  if ((mine?.n ?? 0) >= MAX_OPEN_THREADS_PER_AUTHOR) {
    return new AppError(409, 'TOO_MANY_OPEN', `${theirs} too many open comments on this page.`);
  }
  return new AppError(409, 'PAGE_FULL', 'This page has too many open comments.');
};

// A thread id is only meaningful within its site: another site's id is 404.
const threadOf = async (ctx: Ctx, id: string) => {
  const row = await db(ctx)
    .prepare('SELECT * FROM threads WHERE site = ? AND id = ?')
    .bind(siteKey(ctx), id)
    .first<ThreadRow>();
  if (!row) throw new AppError(404, 'THREAD_NOT_FOUND');
  return row;
};

export const replyTo = async (ctx: Ctx, email: string, threadId: string, raw: unknown) => {
  const input = parseBody(raw, { body: BODY });
  const site = siteKey(ctx);
  const thread = await threadOf(ctx, threadId);
  const resolved = () => new AppError(409, 'THREAD_RESOLVED', 'Reopen the thread to reply.');
  if (thread.state !== 'open') throw resolved();
  const now = Date.now();
  await recordWrite(ctx, email, now);
  const id = crypto.randomUUID();
  // The thread must still be open when the reply is written, not only when read.
  const done = await db(ctx)
    .prepare(
      `INSERT INTO replies (site, id, thread_id, author, body, created_at)
       SELECT ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM threads WHERE site = ? AND id = ? AND state = 'open')
         AND (SELECT count(*) FROM replies WHERE site = ? AND thread_id = ?) < ?
         AND (SELECT count(*) FROM replies WHERE site = ? AND thread_id = ? AND author = ?) < ?`,
    )
    .bind(
      site,
      id,
      threadId,
      email,
      input.body,
      new Date(now).toISOString(),
      site,
      threadId,
      site,
      threadId,
      MAX_REPLIES_PER_THREAD,
      site,
      threadId,
      email,
      MAX_REPLIES_PER_AUTHOR,
    )
    .run();
  if (done.meta.changes > 0) return { id };
  if ((await threadOf(ctx, threadId)).state !== 'open') throw resolved();
  const mine = await db(ctx)
    .prepare('SELECT count(*) AS n FROM replies WHERE site = ? AND thread_id = ? AND author = ?')
    .bind(site, threadId, email)
    .first<{ n: number }>();
  if ((mine?.n ?? 0) >= MAX_REPLIES_PER_AUTHOR) {
    throw new AppError(409, 'TOO_MANY_REPLIES', 'You have replied to this thread too many times.');
  }
  throw new AppError(409, 'THREAD_FULL', 'This thread has too many replies.');
};

const canSettle = (thread: ThreadRow, email: string, role: Role) => isTeam(role) || thread.author === email;

// Once the team has resolved a thread, only the team can reopen it; an author
// may reopen only what they resolved themselves. Otherwise any reader could
// keep a page from ever being ready by reopening their own comment.
const canReopen = (thread: ThreadRow, email: string, role: Role) =>
  isTeam(role) || (thread.author === email && thread.resolved_by === email);

export const resolveThread = async (ctx: Ctx, email: string, role: Role, threadId: string, raw: unknown) => {
  const input = parseBody(raw, { pr: { kind: 'int', min: 1, max: 1_000_000, optional: true } });
  const thread = await threadOf(ctx, threadId);
  if (!canSettle(thread, email, role)) throw new AppError(403, 'FORBIDDEN');
  await recordWrite(ctx, email, Date.now());
  const done = await db(ctx)
    .prepare(
      `UPDATE threads SET state = 'resolved', resolved_by = ?, resolved_pr = ?, resolved_at = ?
       WHERE site = ? AND id = ? AND state = 'open'`,
    )
    .bind(email, input.pr ?? null, new Date().toISOString(), siteKey(ctx), threadId)
    .run();
  if (done.meta.changes === 0) throw new AppError(409, 'ALREADY_RESOLVED');
  return { id: threadId, state: 'resolved' };
};

export const reopenThread = async (ctx: Ctx, email: string, role: Role, threadId: string, raw: unknown) => {
  parseBody(raw, {});
  const site = siteKey(ctx);
  const thread = await threadOf(ctx, threadId);
  if (thread.state === 'open') throw new AppError(409, 'ALREADY_OPEN');
  if (!canReopen(thread, email, role)) throw new AppError(403, 'FORBIDDEN');
  const now = Date.now();
  await recordWrite(ctx, email, now);
  const at = new Date(now).toISOString();
  // A thread on a page that has since been removed can still be reopened; its
  // own hash stands in for the page's in the status history row.
  const pageHash = await pageOf(ctx.deps.store, site, thread.page).then(
    (p) => p.hash,
    (err: unknown) => {
      if (err instanceof AppError && err.code === 'UNKNOWN_PAGE') return thread.page_hash;
      throw err;
    },
  );
  // Reopening counts against the same caps as posting: the page's, and the
  // thread author's.
  const reopen = db(ctx)
    .prepare(
      `UPDATE threads SET state = 'open', resolved_by = NULL, resolved_pr = NULL, resolved_at = NULL
       WHERE site = ? AND id = ? AND state = 'resolved' AND ${OPEN_ON_PAGE} < ? AND ${OPEN_BY_AUTHOR} < ?`,
    )
    .bind(
      site,
      threadId,
      site,
      thread.page,
      MAX_OPEN_THREADS_PER_PAGE,
      site,
      thread.page,
      thread.author,
      MAX_OPEN_THREADS_PER_AUTHOR,
    );
  const [done, demoted] = await db(ctx).batch([reopen, ...demoteIfReady(ctx, thread.page, email, at, pageHash)]);
  if (done.meta.changes === 0 && (await threadOf(ctx, threadId)).state === 'open') {
    throw new AppError(409, 'ALREADY_OPEN');
  }
  if (done.meta.changes === 0) throw await whyRefused(ctx, thread.page, thread.author, email);
  if (demoted.meta.changes > 0) await syncLogged(ctx, thread.page);
  return { id: threadId, state: 'open' };
};
