import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { call, comment, errorCode, installFetch, PAGE, reset } from './helpers';

let spy: ReturnType<typeof installFetch>;
beforeEach(async () => {
  spy = installFetch();
  await reset();
});
afterEach(() => spy.mockRestore());

const READER = 'riya@initech.example';
const OTHER = 'kabir@initech.example';
const TEAM = 'manish@acme.dev';

type Thread = {
  id: string;
  author: string;
  state: string;
  outdated: boolean;
  pageHash: string;
  resolvedBy: string | null;
  resolvedPr: number | null;
  replies: { author: string; body: string }[];
};
// The team's view, which carries emails; what a reader sees is in visibility.test.ts.
const threads = async (email = TEAM) =>
  (await call(`/api/comments?page=${encodeURIComponent(PAGE)}`, { email })).body as unknown as Thread[];

describe('posting', () => {
  it('5: author comes from the token; page hash from the build', async () => {
    const r = await comment(READER);
    expect(r.status).toBe(201);
    const [t] = await threads();
    expect(t).toMatchObject({ id: r.body.id, author: READER, state: 'open', pageHash: 'hash-live', outdated: false });
  });

  it('6, 43: fields the server derives are refused', async () => {
    for (const extra of [
      { author: 'boss@acme.dev' },
      { state: 'resolved' },
      { createdAt: '2020' },
      { pageHash: 'x' },
      { toString: 'x' },
      { constructor: 'x' },
    ]) {
      const r = await comment(READER, extra);
      expect(r.status).toBe(400);
      expect(errorCode(r)).toBe('VALIDATION_FAILED');
    }
    expect(await threads()).toHaveLength(0);
  });

  it('7, 42: body and field validation', async () => {
    const cases: Record<string, unknown>[] = [
      { body: '' },
      { body: '   ' },
      { body: 'x'.repeat(5_001) },
      { body: 'bell\u0007' },
      { quote: '' },
      { page: 'onboarding/missing' },
      { page: '../manifest' },
      { page: 'onboarding%2Fsignup' },
      { page: '__proto__' },
      { body: 42 },
      { body: null },
      { body: ['a'] },
      { heading: 'limits\nx' },
    ];
    for (const c of cases) expect((await comment(READER, c)).status, JSON.stringify(c)).toBe(400);
    for (const raw of ['[]', 'null', '"text"', '{"page":']) {
      expect((await call('/api/comments', { email: READER, rawBody: raw })).status, raw).toBe(400);
    }
    expect(await threads()).toHaveLength(0);
  });

  it('a line break inside a comment body is allowed', async () => {
    expect((await comment(READER, { body: 'line one\nline two' })).status).toBe(201);
  });

  it('44: heading not on the page; quote outside the named section', async () => {
    expect(errorCode(await comment(READER, { heading: 'nope' }))).toBe('UNKNOWN_HEADING');
    expect(errorCode(await comment(READER, { heading: 'who-can-sign-up' }))).toBe('QUOTE_NOT_IN_SECTION');
  });

  it('13: a quote that differs only in spacing is found', async () => {
    expect((await comment(READER, { quote: 'including   ones\nwaiting for approval' })).status).toBe(201);
  });
});

describe('listing', () => {
  it('8: threads oldest first with their replies', async () => {
    const a = await comment(READER, { body: 'first' });
    await comment(OTHER, { body: 'second' });
    await call(`/api/comments/${a.body.id}/replies`, { email: TEAM, body: { body: 'answer' } });
    const list = await threads();
    expect(list.map((t) => t.author)).toEqual([READER, OTHER]);
    expect(list[0].replies).toEqual([expect.objectContaining({ author: TEAM, body: 'answer' })]);
  });

  it('13: a thread whose quote left its section is outdated', async () => {
    const r = await comment(READER);
    await env.DB.prepare('UPDATE threads SET quote = ? WHERE id = ?')
      .bind('anyone with the join link can join', r.body.id)
      .run();
    expect((await threads())[0].outdated).toBe(true);
  });
});

describe('replies, resolve and reopen', () => {
  it('9: reply to a thread; an unknown thread is 404; replies are not nested', async () => {
    const r = await comment(READER);
    expect((await call(`/api/comments/${r.body.id}/replies`, { email: OTHER, body: { body: 'me too' } })).status).toBe(
      201,
    );
    const missing = crypto.randomUUID();
    expect((await call(`/api/comments/${missing}/replies`, { email: OTHER, body: { body: 'x' } })).status).toBe(404);
    expect((await call(`/api/comments/${r.body.id}/replies/x`, { email: OTHER, body: { body: 'x' } })).status).toBe(
      404,
    );
  });

  it('45: replies get the same validation', async () => {
    const r = await comment(READER);
    for (const body of ['', 'x'.repeat(5_001), 'bell\u0007', 7]) {
      expect((await call(`/api/comments/${r.body.id}/replies`, { email: OTHER, body: { body } })).status).toBe(400);
    }
    expect(
      (await call(`/api/comments/${r.body.id}/replies`, { email: OTHER, body: { body: 'ok', author: TEAM } })).status,
    ).toBe(400);
  });

  it('10: the author resolves; a team member resolves with a PR', async () => {
    const mine = await comment(READER);
    expect((await call(`/api/comments/${mine.body.id}/resolve`, { email: READER, body: {} })).status).toBe(200);
    const theirs = await comment(OTHER);
    expect((await call(`/api/comments/${theirs.body.id}/resolve`, { email: TEAM, body: { pr: 60 } })).status).toBe(200);
    const [a, b] = await threads();
    expect(a).toMatchObject({ state: 'resolved', resolvedBy: READER, resolvedPr: null });
    expect(b).toMatchObject({ state: 'resolved', resolvedBy: TEAM, resolvedPr: 60 });
  });

  it('11: another outside reader cannot resolve or reopen', async () => {
    const r = await comment(READER);
    expect((await call(`/api/comments/${r.body.id}/resolve`, { email: OTHER, body: {} })).status).toBe(403);
    await call(`/api/comments/${r.body.id}/resolve`, { email: TEAM, body: {} });
    expect((await call(`/api/comments/${r.body.id}/reopen`, { email: OTHER, body: {} })).status).toBe(403);
  });

  it('12: a team member reopens; repeating either is 409; replying to a resolved thread is 409', async () => {
    const r = await comment(READER);
    await call(`/api/comments/${r.body.id}/resolve`, { email: TEAM, body: {} });
    expect(errorCode(await call(`/api/comments/${r.body.id}/resolve`, { email: TEAM, body: {} }))).toBe(
      'ALREADY_RESOLVED',
    );
    expect(errorCode(await call(`/api/comments/${r.body.id}/replies`, { email: TEAM, body: { body: 'x' } }))).toBe(
      'THREAD_RESOLVED',
    );
    expect((await call(`/api/comments/${r.body.id}/reopen`, { email: TEAM, body: {} })).status).toBe(200);
    expect(errorCode(await call(`/api/comments/${r.body.id}/reopen`, { email: TEAM, body: {} }))).toBe('ALREADY_OPEN');
    expect((await threads())[0]).toMatchObject({ state: 'open', resolvedBy: null });
  });

  it('42: PR number negative, zero, fractional or huge', async () => {
    const r = await comment(READER);
    for (const pr of [-1, 0, 1.5, 10_000_000, '60']) {
      expect((await call(`/api/comments/${r.body.id}/resolve`, { email: TEAM, body: { pr } })).status).toBe(400);
    }
  });
});

describe('limits', () => {
  it('51: the 31st write in a minute is refused', async () => {
    // Spread over two threads so the per-author reply cap (20) is not what stops it.
    const a = await comment(OTHER, { body: 'a' });
    const b = await comment(OTHER, { body: 'b' });
    for (let i = 0; i < 30; i++) {
      const id = i % 2 === 0 ? a.body.id : b.body.id;
      expect((await call(`/api/comments/${id}/replies`, { email: READER, body: { body: `n${i}` } })).status).toBe(201);
    }
    const r = await call(`/api/comments/${a.body.id}/replies`, { email: READER, body: { body: 'one too many' } });
    expect(r.status).toBe(429);
    expect((await comment(OTHER, { body: 'still fine' })).status).toBe(201);
  });

  it('47: text is stored and returned as text, untouched', async () => {
    const body = '<script>alert(1)</script><img src=x onerror=alert(1)> [x](javascript:alert(1))';
    await comment(READER, { body });
    expect((await threads())[0]).toMatchObject({ author: READER });
    const raw = await call(`/api/comments?page=${encodeURIComponent(PAGE)}`, { email: READER });
    expect(raw.headers.get('content-type')).toContain('application/json');
    expect((raw.body as unknown as { body: string }[])[0].body).toBe(body);
  });
});

// Filler threads with UUID-shaped ids (the thread routes accept only those).
const fillerId = (prefix: string, i: number) => `${prefix}-0000-4000-8000-${String(i).padStart(12, '0')}`;
const fill = (count: number, state: 'open' | 'resolved', author = 'filler@x.example', prefix = '0000000f') =>
  env.DB.prepare(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
     INSERT INTO threads (site, id, page, heading, quote, page_hash, author, body, state, resolved_at, created_at)
     SELECT 'acme/sidecar', ? || '-0000-4000-8000-' || printf('%012d', i), ?, 'limits', 'x', 'h', ?, 'b', ?, CASE WHEN ? = 'resolved' THEN '2026-01-01' END,
            printf('2026-01-01T00:%04d', i)
     FROM n`,
  )
    .bind(count, prefix, PAGE, author, state, state)
    .run();

describe('caps', () => {
  it('only open threads count: a page at 200 open refuses another; resolving one frees room', async () => {
    await fill(200, 'open');
    const full = await comment(OTHER);
    expect(errorCode(full)).toBe('PAGE_FULL');
    expect((await call(`/api/comments/${fillerId('0000000f', 1)}/resolve`, { email: TEAM, body: {} })).status).toBe(
      200,
    );
    expect((await comment(OTHER)).status).toBe(201);
  });

  it('a page with 500 resolved threads still takes comments', async () => {
    await fill(500, 'resolved');
    expect((await comment(OTHER)).status).toBe(201);
  });

  it('one author is capped at 20 open threads on a page; others are not', async () => {
    await fill(20, 'open', READER);
    expect(errorCode(await comment(READER))).toBe('TOO_MANY_OPEN');
    expect((await comment(OTHER)).status).toBe(201);
  });

  it('reopening is refused while the page is at the open cap', async () => {
    const mine = await comment(READER);
    await call(`/api/comments/${mine.body.id}/resolve`, { email: READER, body: {} });
    await fill(200, 'open');
    expect(errorCode(await call(`/api/comments/${mine.body.id}/reopen`, { email: READER, body: {} }))).toBe(
      'PAGE_FULL',
    );
  });

  it('every open thread is listed, and the newest 300 resolved', async () => {
    await fill(200, 'open', 'a@x.example', '0000000a');
    await fill(400, 'resolved', 'b@x.example', '0000000b');
    const list = await threads();
    expect(list.filter((t) => t.state === 'open')).toHaveLength(200);
    expect(list.filter((t) => t.state === 'resolved')).toHaveLength(300);
  });

  it('a thread takes 200 replies, and 20 from any one person', async () => {
    const first = await comment(READER);
    const addReplies = (count: number, author: string, prefix: string) =>
      env.DB.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
         INSERT INTO replies (site, id, thread_id, author, body, created_at)
         SELECT 'acme/sidecar', ? || i, ?, ?, 'b', '2026-01-01' FROM n`,
      )
        .bind(count, prefix, first.body.id, author)
        .run();
    await addReplies(20, OTHER, 'mine-');
    const mine = await call(`/api/comments/${first.body.id}/replies`, { email: OTHER, body: { body: 'more' } });
    expect(errorCode(mine)).toBe('TOO_MANY_REPLIES');
    expect((await call(`/api/comments/${first.body.id}/replies`, { email: TEAM, body: { body: 'ok' } })).status).toBe(
      201,
    );
    await addReplies(179, 'many@x.example', 'many-');
    const full = await call(`/api/comments/${first.body.id}/replies`, { email: TEAM, body: { body: 'more' } });
    expect(errorCode(full)).toBe('THREAD_FULL');
  });

  it('reopening counts against the author cap too', async () => {
    const mine = await comment(READER);
    await call(`/api/comments/${mine.body.id}/resolve`, { email: READER, body: {} });
    await fill(20, 'open', READER);
    const r = await call(`/api/comments/${mine.body.id}/reopen`, { email: READER, body: {} });
    expect(errorCode(r)).toBe('TOO_MANY_OPEN');
  });
});

describe('who can reopen', () => {
  it('a reader can reopen what they resolved, not what the team resolved', async () => {
    const a = await comment(READER, { body: 'a' });
    await call(`/api/comments/${a.body.id}/resolve`, { email: READER, body: {} });
    expect((await call(`/api/comments/${a.body.id}/reopen`, { email: READER, body: {} })).status).toBe(200);
    await call(`/api/comments/${a.body.id}/resolve`, { email: TEAM, body: {} });
    expect((await call(`/api/comments/${a.body.id}/reopen`, { email: READER, body: {} })).status).toBe(403);
    expect((await call(`/api/comments/${a.body.id}/reopen`, { email: TEAM, body: {} })).status).toBe(200);
  });
});

describe('removed text stays with the team', () => {
  it('an outdated thread shows its quote to the team and hides it from readers', async () => {
    const r = await comment(READER, { prefix: 'before', suffix: 'after' });
    await env.DB.prepare('UPDATE threads SET quote = ? WHERE id = ?').bind('a passage since removed', r.body.id).run();
    const forReader = (await threads(READER))[0] as unknown as Record<string, unknown>;
    expect(forReader).toMatchObject({ outdated: true, quote: '', prefix: '', suffix: '', quoteHidden: true });
    const forTeam = (await threads(TEAM))[0] as unknown as Record<string, unknown>;
    expect(forTeam).toMatchObject({ outdated: true, quote: 'a passage since removed', quoteHidden: false });
  });

  it('a current thread shows its quote to everyone', async () => {
    await comment(READER);
    expect((await threads(OTHER))[0]).toMatchObject({ quote: 'including ones waiting for approval' });
  });
});

describe('final review fixes', () => {
  it('a thread on a deleted section gives readers no section id; the team keeps it', async () => {
    const r = await comment(READER);
    await env.DB.prepare('UPDATE threads SET heading = ?, quote = ? WHERE id = ?')
      .bind('acquisition-terms', 'removed text', r.body.id)
      .run();
    expect((await threads(READER))[0]).toMatchObject({ heading: '', quote: '' });
    expect((await threads(TEAM))[0]).toMatchObject({ heading: 'acquisition-terms', quote: 'removed text' });
  });

  it('reopening an open thread is 409 for its author, not 403', async () => {
    const r = await comment(READER);
    expect(errorCode(await call(`/api/comments/${r.body.id}/reopen`, { email: READER, body: {} }))).toBe(
      'ALREADY_OPEN',
    );
  });

  it("a team member's refused reopen names the author, not the caller", async () => {
    const r = await comment(READER);
    await call(`/api/comments/${r.body.id}/resolve`, { email: TEAM, body: {} });
    await fill(20, 'open', READER);
    const res = await call(`/api/comments/${r.body.id}/reopen`, { email: TEAM, body: {} });
    expect(errorCode(res)).toBe('TOO_MANY_OPEN');
    expect((res.body as unknown as { error: { message: string } }).error.message).toMatch(/^Its author has/);
  });
});
