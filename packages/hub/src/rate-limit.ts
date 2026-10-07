import { type Ctx, siteKey } from './ctx';
import { AppError } from './http';

export const WRITES_PER_MINUTE = 30;

// Per site and email. Approximate under concurrency (two requests can both
// read 29), which is fine for its purpose: stopping one identity from
// flooding the database. A write is counted before it is attempted, so a
// refused one still uses the allowance; that only slows down someone already
// hitting a limit. write_log is indexed on (site, email, at).
export const recordWrite = async (ctx: Ctx, email: string, now: number): Promise<void> => {
  const site = siteKey(ctx);
  const db = ctx.env.DB;
  const row = await db
    .prepare('SELECT count(*) AS n FROM write_log WHERE site = ? AND email = ? AND at > ?')
    .bind(site, email, now - 60_000)
    .first<{ n: number }>();
  if ((row?.n ?? 0) >= WRITES_PER_MINUTE) throw new AppError(429, 'RATE_LIMITED', 'Too many changes; wait a minute.');
  await db.batch([
    db.prepare('INSERT INTO write_log (site, email, at) VALUES (?, ?, ?)').bind(site, email, now),
    db.prepare('DELETE FROM write_log WHERE at < ?').bind(now - 3_600_000),
  ]);
};
