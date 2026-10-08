import { STATUSES, type Status } from '@specreview/shared';
import { type Ctx, siteKey } from './ctx';
import { syncSiteLabels } from './github';
import { AppError } from './http';
import { pageOf } from './manifest';
import { recordWrite } from './rate-limit';
import { type Caller, shownAs } from './identity';
import type { Role } from './roles';
import { effectiveStatus, readSiteStatuses, readStatusRow } from './status-read';
import { parseBody } from './validate';

export const listStatuses = async (ctx: Ctx, caller: Caller) => {
  const site = siteKey(ctx);
  const show = shownAs(ctx.site, caller);
  const { manifest } = await ctx.snapshot();
  const byPage = new Map((await readSiteStatuses(ctx.env, site)).map((r) => [r.page, r]));
  return Object.entries(manifest.pages).map(([page, entry]) => {
    const effective = effectiveStatus(byPage.get(page) ?? null, entry.hash);
    const changedBy = effective.changedBy === null ? null : show(effective.changedBy);
    return { page, title: entry.title, hash: entry.hash, ...effective, changedBy };
  });
};

const isStatus = (s: string): s is Status => (STATUSES as readonly string[]).includes(s);

// Who may move a page to which status. Ready is the product sign-off.
const mayChoose: Record<Status, (role: Role) => boolean> = {
  pending: (role) => role !== 'reader',
  in_review: (role) => role !== 'reader',
  ready: (role) => role === 'approver',
};

export const changeStatus = async (ctx: Ctx, email: string, role: Role, raw: unknown) => {
  const input = parseBody(raw, {
    page: { kind: 'string', max: 200 },
    status: { kind: 'string', max: 20 },
    expectedVersion: { kind: 'int', min: 0, max: 1_000_000 },
    hash: { kind: 'string', max: 100 },
  });
  if (!isStatus(input.status)) throw new AppError(400, 'VALIDATION_FAILED', 'status: unknown value');
  const status = input.status;
  if (!mayChoose[status](role)) throw new AppError(403, 'FORBIDDEN');
  const site = siteKey(ctx);
  const entry = pageOf(await ctx.snapshot(), input.page);
  // The client sends the content it was looking at; a sign-off for older
  // content than is live would approve something nobody read.
  if (input.hash !== entry.hash) throw new AppError(409, 'STALE_CONTENT', 'The page changed; reload it.');

  const row = await readStatusRow(ctx.env, site, input.page);
  const current = effectiveStatus(row, entry.hash);
  if (current.version !== input.expectedVersion) throw new AppError(409, 'STALE_STATUS', 'Someone changed it; reload.');
  if (current.status === status && !current.wasReadyAt) throw new AppError(409, 'NO_CHANGE');

  const now = Date.now();
  await recordWrite(ctx, email, now);
  const at = new Date(now).toISOString();
  const readyHash = status === 'ready' ? entry.hash : null;
  const next = input.expectedVersion + 1;
  const db = ctx.env.DB;

  // One guarded statement: the version must still be the one the client saw,
  // and ready also requires no open comment on this site's page at the moment
  // of writing. Bind order of the guard: status, site, page.
  const guard = `(? != 'ready' OR NOT EXISTS (SELECT 1 FROM threads WHERE site = ? AND page = ? AND state = 'open'))`;
  const write =
    input.expectedVersion === 0
      ? db
          .prepare(
            `INSERT INTO page_status (site, page, status, version, ready_hash, changed_by, changed_at)
             SELECT ?, ?, ?, 1, ?, ?, ?
             WHERE NOT EXISTS (SELECT 1 FROM page_status WHERE site = ? AND page = ?) AND ${guard}`,
          )
          .bind(site, input.page, status, readyHash, email, at, site, input.page, status, site, input.page)
      : db
          .prepare(
            `UPDATE page_status SET status = ?, version = version + 1, ready_hash = ?, changed_by = ?, changed_at = ?
             WHERE site = ? AND page = ? AND version = ? AND ${guard}`,
          )
          .bind(status, readyHash, email, at, site, input.page, input.expectedVersion, status, site, input.page);
  const history = db
    .prepare(
      `INSERT INTO status_history (site, id, page, status, version, page_hash, changed_by, changed_at)
       SELECT site, ?, page, status, version, ?, changed_by, changed_at FROM page_status
       WHERE site = ? AND page = ? AND version = ? AND changed_by = ? AND changed_at = ?`,
    )
    .bind(crypto.randomUUID(), entry.hash, site, input.page, next, email, at);
  const [written] = await db.batch([write, history]);

  if (written.meta.changes === 0) {
    const after = await readStatusRow(ctx.env, site, input.page);
    if ((after?.version ?? 0) !== input.expectedVersion) throw new AppError(409, 'STALE_STATUS');
    throw new AppError(409, 'OPEN_COMMENTS', 'Resolve the open comments first.');
  }

  const labels = await syncSiteLabels(ctx, input.page).catch(() => 'failed' as const);
  return { page: input.page, status, version: next, labels };
};
