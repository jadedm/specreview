import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { call, comment, errorCode, github, installFetch, LIVE_HASH, PAGE, reset } from './helpers';

let spy: ReturnType<typeof installFetch>;
beforeEach(async () => {
  spy = installFetch();
  await reset();
});
afterEach(() => spy.mockRestore());

const READER = 'riya@initech.example';
const TEAM = 'dev@acme.dev';
const APPROVER = 'approver@acme.dev';

type Row = { page: string; status: string; version: number; wasReadyAt: string | null };
const statuses = async () => (await call('/api/status', { email: READER })).body as unknown as Row[];
const statusOf = async (page = PAGE) => (await statuses()).find((s) => s.page === page)!;
const setStatus = (email: string, status: string, expectedVersion: number, hash = LIVE_HASH) =>
  call('/api/status', { email, body: { page: PAGE, status, expectedVersion, hash } });

describe('reading', () => {
  it('15: every built page is listed; no row means pending', async () => {
    const list = await statuses();
    expect(list.map((s) => s.page).sort()).toEqual(['index', 'onboarding/approval', PAGE]);
    expect(list.every((s) => s.status === 'pending' && s.version === 0)).toBe(true);
  });
});

describe('changing', () => {
  it('16: team sets in review with a history row; a reader cannot change anything', async () => {
    const r = await setStatus(TEAM, 'in_review', 0);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'in_review', version: 1 });
    const history = await env.DB.prepare('SELECT * FROM status_history WHERE page = ?').bind(PAGE).all();
    expect(history.results).toEqual([expect.objectContaining({ status: 'in_review', version: 1, changed_by: TEAM })]);
    for (const s of ['pending', 'in_review', 'ready']) expect((await setStatus(READER, s, 1)).status).toBe(403);
  });

  it('17: an approver marks ready; a team member who is not an approver cannot', async () => {
    await setStatus(TEAM, 'in_review', 0);
    expect((await setStatus(TEAM, 'ready', 1)).status).toBe(403);
    expect((await setStatus(APPROVER, 'ready', 1)).status).toBe(200);
    expect((await statusOf()).status).toBe('ready');
  });

  it('36: every role against every transition', async () => {
    const roles = { reader: READER, team: TEAM, approver: APPROVER };
    const allowed: Record<string, string[]> = {
      reader: [],
      team: ['pending', 'in_review'],
      approver: ['pending', 'in_review', 'ready'],
    };
    for (const [role, email] of Object.entries(roles)) {
      for (const target of ['pending', 'in_review', 'ready']) {
        await reset();
        // Start from a status other than the target.
        expect((await setStatus(APPROVER, 'in_review', 0)).status).toBe(200);
        const startVersion = target === 'in_review' ? 2 : 1;
        if (target === 'in_review') expect((await setStatus(APPROVER, 'pending', 1)).status).toBe(200);
        const r = await setStatus(email, target, startVersion);
        const ok = allowed[role].includes(target);
        expect(r.status, `${role} -> ${target}`).toBe(ok ? 200 : 403);
      }
    }
  });

  it('36: the same status again is 409; ready back to pending is allowed', async () => {
    await setStatus(TEAM, 'in_review', 0);
    expect(errorCode(await setStatus(TEAM, 'in_review', 1))).toBe('NO_CHANGE');
    await setStatus(APPROVER, 'ready', 1);
    expect((await setStatus(TEAM, 'pending', 2)).status).toBe(200);
  });

  it('37: two changes from the same version: one wins, one 409, one history row', async () => {
    const [a, b] = await Promise.all([setStatus(TEAM, 'in_review', 0), setStatus(APPROVER, 'ready', 0)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const history = await env.DB.prepare('SELECT count(*) AS n FROM status_history').first<{ n: number }>();
    expect(history?.n).toBe(1);
  });

  it('37: two changes from version 1: one wins, one 409', async () => {
    await setStatus(TEAM, 'in_review', 0);
    const [a, b] = await Promise.all([setStatus(TEAM, 'pending', 1), setStatus(APPROVER, 'ready', 1)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await statusOf()).version).toBe(2);
    const history = await env.DB.prepare('SELECT count(*) AS n FROM status_history').first<{ n: number }>();
    expect(history?.n).toBe(2);
  });

  it('18, 38: ready is refused while a live comment is open', async () => {
    await setStatus(TEAM, 'in_review', 0);
    await comment(READER);
    const r = await setStatus(APPROVER, 'ready', 1);
    expect(r.status).toBe(409);
    expect(errorCode(r)).toBe('OPEN_COMMENTS');
    expect((await statusOf()).status).toBe('in_review');
  });

  it('18: also on the very first change (no row yet)', async () => {
    await comment(READER);
    expect(errorCode(await setStatus(APPROVER, 'ready', 0))).toBe('OPEN_COMMENTS');
  });

  it('39: ready sent with content that is not live', async () => {
    const r = await setStatus(APPROVER, 'ready', 0, 'hash-old');
    expect(errorCode(r)).toBe('STALE_CONTENT');
  });

  it('a stale version is 409 STALE_STATUS', async () => {
    await setStatus(TEAM, 'in_review', 0);
    expect(errorCode(await setStatus(TEAM, 'pending', 0))).toBe('STALE_STATUS');
  });

  it('19: a page changed after ready counts as in review, showing when it was ready', async () => {
    await setStatus(APPROVER, 'ready', 0);
    await env.DB.prepare('UPDATE page_status SET ready_hash = ? WHERE page = ?').bind('hash-before', PAGE).run();
    const s = await statusOf();
    expect(s.status).toBe('in_review');
    expect(s.wasReadyAt).not.toBeNull();
    expect((await setStatus(APPROVER, 'ready', 1)).status).toBe(200);
  });

  it('42: unknown status, wrong types, unknown fields', async () => {
    for (const body of [
      { page: PAGE, status: 'shipped', expectedVersion: 0, hash: LIVE_HASH },
      { page: PAGE, status: 'ready', expectedVersion: '0', hash: LIVE_HASH },
      { page: PAGE, status: 'ready', expectedVersion: -1, hash: LIVE_HASH },
      { page: PAGE, status: 'ready', expectedVersion: 0, hash: LIVE_HASH, version: 9 },
    ]) {
      expect((await call('/api/status', { email: APPROVER, body })).status).toBe(400);
    }
  });
});

describe('20: labels on linked tickets', () => {
  const docsLabels = (n: number) => github.issues.get(n)!.labels.filter((l) => l.startsWith('docs:'));

  it('each linked ticket ends with exactly the new label', async () => {
    const r = await setStatus(TEAM, 'in_review', 0);
    expect(r.body).toMatchObject({ labels: 'updated' });
    expect(docsLabels(23)).toEqual(['docs: in review']);
    expect(github.issues.get(52)!.labels).toContain('enhancement');
    await setStatus(APPROVER, 'ready', 1);
    expect(docsLabels(23)).toEqual(['docs: ready to build']);
  });

  it('a ticket on two pages takes the less advanced status', async () => {
    await setStatus(APPROVER, 'ready', 0);
    expect(docsLabels(23)).toEqual(['docs: ready to build']);
    expect(docsLabels(52)).toEqual(['docs: pending']);
    const other = { page: 'onboarding/approval', hash: 'hash-approval' };
    await call('/api/status', { email: APPROVER, body: { ...other, status: 'in_review', expectedVersion: 0 } });
    expect(docsLabels(52)).toEqual(['docs: in review']);
    await call('/api/status', { email: APPROVER, body: { ...other, status: 'ready', expectedVersion: 1 } });
    expect(docsLabels(52)).toEqual(['docs: ready to build']);
  });

  it('whichever page is listed last, the less advanced status wins', async () => {
    const other = { page: 'onboarding/approval', hash: 'hash-approval' };
    await call('/api/status', { email: APPROVER, body: { ...other, status: 'ready', expectedVersion: 0 } });
    expect(docsLabels(52)).toEqual(['docs: pending']);
    await setStatus(TEAM, 'in_review', 0);
    expect(docsLabels(52)).toEqual(['docs: in review']);
  });

  it('21: GitHub down: status saved, response says labels did not update', async () => {
    github.down = true;
    const r = await setStatus(TEAM, 'in_review', 0);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ labels: 'failed', status: 'in_review' });
    expect((await statusOf()).status).toBe('in_review');
  });
});

describe('ready holds only without open comments', () => {
  const docsLabels = (n: number) => github.issues.get(n)!.labels.filter((l) => l.startsWith('docs:'));

  it('a new comment on a ready page puts it back in review, with a history row and labels', async () => {
    await setStatus(APPROVER, 'ready', 0);
    expect(docsLabels(23)).toEqual(['docs: ready to build']);
    expect((await comment(READER)).status).toBe(201);
    const s = await statusOf();
    expect(s).toMatchObject({ status: 'in_review', version: 2 });
    expect(docsLabels(23)).toEqual(['docs: in review']);
    const rows = await env.DB.prepare('SELECT status, changed_by FROM status_history ORDER BY version').all();
    expect(rows.results).toEqual([
      { status: 'ready', changed_by: APPROVER },
      { status: 'in_review', changed_by: READER },
    ]);
  });

  it('reopening a comment on a ready page puts it back in review', async () => {
    const c = await comment(READER);
    await call(`/api/comments/${c.body.id}/resolve`, { email: READER, body: {} });
    await setStatus(APPROVER, 'ready', 0);
    expect((await call(`/api/comments/${c.body.id}/reopen`, { email: READER, body: {} })).status).toBe(200);
    expect((await statusOf()).status).toBe('in_review');
  });

  it('a comment on a page that is not ready changes no status', async () => {
    await setStatus(TEAM, 'in_review', 0);
    await comment(READER);
    expect(await statusOf()).toMatchObject({ status: 'in_review', version: 1 });
  });
});

describe('a page full of resolved threads', () => {
  it('a comment on a ready page with 500 resolved threads is taken and puts it back in review', async () => {
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 500)
       INSERT INTO threads (site, id, page, heading, quote, page_hash, author, body, state, created_at)
       SELECT 'acme/sidecar', 'done-' || i, ?, 'limits', 'x', 'h', 'f@x', 'b', 'resolved', '2026-01-01' FROM n`,
    )
      .bind(PAGE)
      .run();
    await setStatus(APPROVER, 'ready', 0);
    expect((await comment(READER)).status).toBe(201);
    expect((await statusOf()).status).toBe('in_review');
  });
});
