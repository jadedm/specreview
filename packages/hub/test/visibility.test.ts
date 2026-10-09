// What a reader may see of other people (#14): labels instead of emails, no
// ticket titles or links, no page history. The team sees everything.
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  call,
  comment,
  CONFIG,
  deps,
  errorCode,
  github,
  installFetch,
  keyOf,
  LIVE_HASH,
  manifests,
  PAGE,
  publishedFiles,
  reset,
  SIDECAR,
  WEB,
} from './helpers';
import { memoryStore } from '../src/store';

let spy: ReturnType<typeof installFetch>;
beforeEach(async () => {
  spy = installFetch();
  await reset();
  // Sentinels: ticket titles that must never reach a reader.
  github.issues.get(52)!.title = 'SENTINEL-TITLE-52';
  github.issues.get(23)!.title = 'SENTINEL-TITLE-23';
});
afterEach(() => spy.mockRestore());

const READER = 'riya@initech.example';
const OTHER = 'kabir@initech.example';
const TEAM = 'dev@acme.dev';
const APPROVER = 'approver@acme.dev';
const LABEL = 'acme team';
const IDENTITIES = [TEAM, APPROVER, OTHER];
const TITLES = ['SENTINEL-TITLE-52', 'SENTINEL-TITLE-23'];

type Reply = { author: string; mine: boolean; body: string };
type Thread = { id: string; author: string; mine: boolean; resolvedBy: string | null; replies: Reply[] };
type Status = { page: string; changedBy: string | null; wasReadyAt: string | null; status: string };

const q = `page=${encodeURIComponent(PAGE)}`;
const threadsAs = async (email: string) => (await call(`/api/comments?${q}`, { email })).body as unknown as Thread[];
const statusesAs = async (email: string) => (await call('/api/status', { email })).body as unknown as Status[];
const ticketsAs = async (email: string) =>
  (await call(`/api/tickets?${q}`, { email })).body as unknown as Record<string, unknown>[];
const pagesAs = async (email: string) => await call('/api/pages', { email });
const signupStatus = async (email: string) => (await statusesAs(email)).find((s) => s.page === PAGE)!;
const reply = (id: string, email: string, body = 'an answer') =>
  call(`/api/comments/${id}/replies`, { email, body: { body } });
const setStatus = (email: string, status: string, expectedVersion: number) =>
  call('/api/status', { email, body: { page: PAGE, status, expectedVersion, hash: LIVE_HASH } });
const leaks = (body: unknown, needles: string[]) => needles.filter((n) => JSON.stringify(body).includes(n));
const configWith = (patch: (c: typeof CONFIG) => unknown) => ({
  SPECREVIEW_CONFIG: JSON.stringify(patch(structuredClone(CONFIG))),
});

// A thread by each kind of person, each answered by each kind of person.
const seedThreads = async () => {
  const ids: Record<string, string> = {};
  for (const [who, email] of [
    ['team', TEAM],
    ['approver', APPROVER],
    ['other', OTHER],
    ['reader', READER],
  ] as const) {
    const r = await comment(email, { body: `thread by ${who}` });
    expect(r.status, who).toBe(201);
    ids[who] = r.body.id as string;
  }
  for (const email of [TEAM, OTHER, READER]) expect((await reply(ids.team, email)).status).toBe(201);
  return ids;
};

describe('1-3, 8, 16, 24: comments', () => {
  it('1: a reader sees labels for everyone else and You for themself', async () => {
    await seedThreads();
    const list = await threadsAs(READER);
    expect(list.map((t) => [t.author, t.mine])).toEqual([
      [LABEL, false],
      [LABEL, false],
      ['Reader', false],
      ['You', true],
    ]);
    expect(list[0].replies.map((r) => [r.author, r.mine])).toEqual([
      [LABEL, false],
      ['Reader', false],
      ['You', true],
    ]);
    expect(leaks(list, [...IDENTITIES, READER])).toEqual([]);
  });

  it('2, 22: team and approvers see every email, with mine on their own', async () => {
    await seedThreads();
    for (const email of [TEAM, APPROVER]) {
      const list = await threadsAs(email);
      expect(list.map((t) => t.author)).toEqual([TEAM, APPROVER, OTHER, READER]);
      expect(list.map((t) => t.mine)).toEqual([TEAM, APPROVER, OTHER, READER].map((a) => a === email));
      expect(list[0].replies.map((r) => r.author)).toEqual([TEAM, OTHER, READER]);
    }
  });

  it('3: resolvedBy is labelled for a reader', async () => {
    const ids = await seedThreads();
    expect((await call(`/api/comments/${ids.approver}/resolve`, { email: TEAM, body: { pr: 60 } })).status).toBe(200);
    expect((await call(`/api/comments/${ids.reader}/resolve`, { email: READER, body: {} })).status).toBe(200);
    expect((await call(`/api/comments/${ids.other}/resolve`, { email: OTHER, body: {} })).status).toBe(200);
    const byId = new Map((await threadsAs(READER)).map((t) => [t.id, t.resolvedBy]));
    expect([byId.get(ids.approver), byId.get(ids.reader), byId.get(ids.other), byId.get(ids.team)]).toEqual([
      LABEL,
      'You',
      'Reader',
      null,
    ]);
    const team = new Map((await threadsAs(TEAM)).map((t) => [t.id, t.resolvedBy]));
    expect(team.get(ids.approver)).toBe(TEAM);
    // The fixing PR is team history.
    const pr = async (email: string) =>
      ((await threadsAs(email)).find((t) => t.id === ids.approver) as unknown as { resolvedPr: number | null })
        .resolvedPr;
    expect([await pr(READER), await pr(TEAM)]).toEqual([null, 60]);
  });

  it('8: the label follows the current config: a team member no longer on a team domain is a Reader', async () => {
    await comment(TEAM, { body: 'from the team' });
    const moved = configWith((c) => {
      c.sites[0].teamDomains = ['acme.example'];
      c.sites[0].approvers = [];
      c.sites[1].teamDomains = ['acme.example'];
      c.sites[1].approvers = [];
      return c;
    });
    const r = await call(`/api/comments?${q}`, { email: READER, envOverride: moved });
    expect((r.body as unknown as Thread[])[0].author).toBe('Reader');
  });

  it('16, 23: readers by exact email and by domain see each other as Reader; team listed as readers stays team', async () => {
    const listed = configWith((c) => {
      c.sites[0].readers = ['@initech.example', 'pm@partner.example', TEAM, '@acme.dev'];
      return c;
    });
    for (const email of [READER, 'pm@partner.example']) {
      expect((await call('/api/comments', { email, envOverride: listed, body: commentBody(email) })).status).toBe(201);
    }
    const asReader = (await call(`/api/comments?${q}`, { email: READER, envOverride: listed }))
      .body as unknown as Thread[];
    expect(asReader.map((t) => t.author)).toEqual(['You', 'Reader']);
    const asPartner = (await call(`/api/comments?${q}`, { email: 'pm@partner.example', envOverride: listed }))
      .body as unknown as Thread[];
    expect(asPartner.map((t) => t.author)).toEqual(['Reader', 'You']);
    const asTeam = (await call(`/api/comments?${q}`, { email: TEAM, envOverride: listed })).body as unknown as Thread[];
    expect(asTeam.map((t) => t.author)).toEqual([READER, 'pm@partner.example']);
    const tickets = (await call(`/api/tickets?${q}`, { email: TEAM, envOverride: listed })).body as unknown as Record<
      string,
      unknown
    >[];
    expect(tickets[0].title).toBe('SENTINEL-TITLE-52');
  });

  it('24: an outdated thread hides its quote and still labels everyone', async () => {
    const ids = await seedThreads();
    await call(`/api/comments/${ids.other}/resolve`, { email: TEAM, body: {} });
    await env.DB.prepare('UPDATE threads SET quote = ? WHERE site = ?')
      .bind('text since removed', keyOf(SIDECAR))
      .run();
    const list = await threadsAs(READER);
    expect(list.every((t) => (t as unknown as { quoteHidden: boolean }).quoteHidden)).toBe(true);
    expect(list.map((t) => t.author)).toEqual([LABEL, LABEL, 'Reader', 'You']);
    expect(list.find((t) => t.id === ids.other)!.resolvedBy).toBe(LABEL);
    expect(leaks(list, [...IDENTITIES, READER])).toEqual([]);
  });
});

const commentBody = (email: string) => ({
  page: PAGE,
  heading: 'limits',
  quote: 'including ones waiting for approval',
  body: `from ${email.split('@')[0]}`,
});

describe('4, 5, 20, 21: page status', () => {
  it('4, 5, 22: changedBy is a label for a reader and the email for team and approvers', async () => {
    expect((await setStatus(TEAM, 'in_review', 0)).status).toBe(200);
    expect((await signupStatus(READER)).changedBy).toBe(LABEL);
    expect((await signupStatus(TEAM)).changedBy).toBe(TEAM);
    expect((await setStatus(APPROVER, 'ready', 1)).status).toBe(200);
    expect((await signupStatus(READER)).changedBy).toBe(LABEL);
    expect((await signupStatus(APPROVER)).changedBy).toBe(APPROVER);
  });

  it("20: a reader's comment that demotes a ready page is theirs to them, Reader to others", async () => {
    expect((await setStatus(APPROVER, 'ready', 0)).status).toBe(200);
    expect((await comment(READER)).status).toBe(201);
    expect((await signupStatus(READER)).changedBy).toBe('You');
    expect((await signupStatus(OTHER)).changedBy).toBe('Reader');
    expect((await signupStatus(TEAM)).changedBy).toBe(READER);
  });

  it('21: a ready page whose content changed keeps wasReadyAt and labels changedBy', async () => {
    expect((await setStatus(APPROVER, 'ready', 0)).status).toBe(200);
    await env.DB.prepare('UPDATE page_status SET ready_hash = ? WHERE site = ?').bind('old', keyOf(SIDECAR)).run();
    const s = await signupStatus(READER);
    expect(s).toMatchObject({ status: 'in_review', changedBy: LABEL });
    expect(s.wasReadyAt).not.toBeNull();
  });
});

describe('6, 7, 18, 19: tickets', () => {
  it('18: a reader gets no title or link, fresh, cached or stale', async () => {
    // A site that files tickets in another site's repo strips them the same way.
    const web = (await call(`/api/tickets?${q}`, { site: WEB, email: READER })).body as unknown as unknown[];
    expect(leaks(web, [...TITLES, 'github.com'])).toEqual([]);
    const fresh = await ticketsAs(READER);
    expect(fresh.map((t) => Object.keys(t).sort())).toEqual([
      ['fetchedAt', 'labels', 'number', 'stale', 'state'],
      ['fetchedAt', 'labels', 'number', 'stale', 'state'],
    ]);
    const before = github.calls.length;
    const cached = await ticketsAs(READER);
    expect(github.calls.length).toBe(before);
    expect(leaks(cached, TITLES)).toEqual([]);
    await env.DB.prepare('UPDATE ticket_cache SET fetched_at = 0').run();
    github.down = true;
    const stale = await ticketsAs(READER);
    expect(stale[0]).toMatchObject({ number: 52, stale: true });
    expect(leaks([fresh, stale], [...TITLES, 'github.com'])).toEqual([]);
  });

  it('6: unavailable and not-found entries are unchanged for a reader', async () => {
    github.issues.delete(23);
    github.down = false;
    expect((await ticketsAs(READER))[1]).toEqual({ number: 23, notFound: true });
    await env.DB.prepare('DELETE FROM ticket_cache').run();
    github.down = true;
    expect((await ticketsAs(READER))[0]).toEqual({ number: 52, unavailable: true });
  });

  it('7, 22: team and approvers get titles and links', async () => {
    for (const email of [TEAM, APPROVER]) {
      const [t] = await ticketsAs(email);
      expect(t).toMatchObject({ number: 52, title: 'SENTINEL-TITLE-52' });
      expect(String(t.url)).toContain('/issues/52');
    }
  });

  it('19: only our three status labels are returned, to everyone', async () => {
    github.issues.get(52)!.labels.push('docs: someone@leak.example', 'docs: in review', 'docs:ready');
    for (const email of [READER, TEAM]) {
      const [t] = await ticketsAs(email);
      expect(t.labels, email).toEqual(['docs: in review']);
    }
  });
});

describe('11-14, 26-29: page data', () => {
  type PagesBody = { commit: string; pages: Record<string, Record<string, unknown>> };

  it('11: a reader gets titles, hashes, issues and sections, and no history', async () => {
    const r = await pagesAs(READER);
    expect(r.status).toBe(200);
    const body = r.body as unknown as PagesBody;
    expect(body.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(body.pages[PAGE]).sort()).toEqual(['hash', 'issues', 'sections', 'title']);
    expect(body.pages[PAGE]).toMatchObject({ hash: LIVE_HASH, issues: [52, 23] });
  });

  it('11: sections carry only id, title and text, whatever else the build wrote', async () => {
    const all = manifests();
    const sections = all[SIDECAR].pages[PAGE].sections as unknown as Record<string, unknown>[];
    sections[0].lastEditedBy = 'leak@acme.dev';
    deps.store = memoryStore(publishedFiles(all));
    for (const email of [READER, TEAM]) {
      const body = (await pagesAs(email)).body as unknown as PagesBody;
      const [first] = body.pages[PAGE].sections as Record<string, unknown>[];
      expect(Object.keys(first).sort(), email).toEqual(['id', 'text', 'title']);
    }
  });

  it('12, 22: team and approvers get history too', async () => {
    for (const email of [TEAM, APPROVER]) {
      const body = (await pagesAs(email)).body as unknown as PagesBody;
      expect((body.pages[PAGE].history as unknown[]).length, email).toBeGreaterThan(0);
    }
  });

  it('29: the cached manifest is never changed, whichever order the roles ask in', async () => {
    for (const order of [
      [READER, TEAM, READER],
      [TEAM, READER, TEAM],
    ]) {
      await reset();
      for (const email of order) {
        const pages = ((await pagesAs(email)).body as unknown as PagesBody).pages[PAGE];
        expect('history' in pages, `${order.join(',')} ${email}`).toBe(email === TEAM);
      }
    }
  });

  it('13, 27: unpublished, broken, no access, no token', async () => {
    const files = publishedFiles();
    files.delete(`${SIDECAR}/current.json`);
    deps.store = memoryStore(files);
    const unpublished = await pagesAs(READER);
    expect([unpublished.status, errorCode(unpublished)]).toEqual([503, 'SITE_NOT_PUBLISHED']);
    files.set(`${SIDECAR}/current.json`, 'not json');
    const broken = await pagesAs(READER);
    expect([broken.status, errorCode(broken)]).toEqual([503, 'SITE_BROKEN']);
    expect((await pagesAs('x@stranger.example')).status).toBe(403);
    expect((await call('/api/pages')).status).toBe(401);
  });

  it('14, 26: only GET; no trailing slash', async () => {
    expect((await call('/api/pages', { email: READER, method: 'POST', body: {} })).status).toBe(405);
    expect((await call('/api/pages', { email: READER, method: 'HEAD' })).status).toBe(405);
    expect((await call('/api/pages/', { email: READER })).status).toBe(404);
  });

  // No bucket bound: default-export.test.ts.
  it('28: storage failing', async () => {
    deps.store = {
      get: () => Promise.reject(new Error('bucket specreview-sites down')),
    };
    const down = await pagesAs(READER);
    expect([down.status, errorCode(down)]).toEqual([503, 'STORAGE_UNAVAILABLE']);
    expect(JSON.stringify(down.body)).not.toContain('specreview-sites');
  });
});

describe('15, 25, 30: whole responses', () => {
  it('15: nothing a reader reads carries another identity or a ticket title', async () => {
    await seedThreads();
    await setStatus(TEAM, 'in_review', 0);
    for (const path of [`/api/comments?${q}`, '/api/status', `/api/tickets?${q}`, '/api/pages']) {
      const r = await call(path, { email: READER });
      expect(r.status, path).toBe(200);
      expect(leaks(r.body, [...IDENTITIES, ...TITLES]), path).toEqual([]);
    }
  });

  it("25: a reader's writes, accepted or refused, carry no other identity or title", async () => {
    const ids = await seedThreads();
    const at = Date.now();
    const site = keyOf(SIDECAR);
    const insertThread = (author: string, n: number) =>
      env.DB.prepare(
        `INSERT INTO threads (site, id, page, heading, quote, page_hash, author, body, created_at)
         VALUES (?, ?, ?, 'limits', 'x', ?, ?, 'seeded', ?)`,
      ).bind(site, crypto.randomUUID(), PAGE, LIVE_HASH, author, new Date(at + n).toISOString());
    const bodies: [string, unknown][] = [];
    const record = (name: string, r: { status: number; body: unknown }, code?: string) => {
      if (code) expect(errorCode(r as { body: unknown }), name).toBe(code);
      bodies.push([name, r.body]);
    };
    record('comment', await comment(READER, { body: 'mine' }));
    record('reply', await reply(ids.team, READER));
    record('resolve own', await call(`/api/comments/${ids.reader}/resolve`, { email: READER, body: {} }));
    record(
      'resolve again',
      await call(`/api/comments/${ids.reader}/resolve`, { email: READER, body: {} }),
      'ALREADY_RESOLVED',
    );
    record('reply to resolved', await reply(ids.reader, READER), 'THREAD_RESOLVED');
    record('reopen own', await call(`/api/comments/${ids.reader}/reopen`, { email: READER, body: {} }));
    record(
      'reopen open',
      await call(`/api/comments/${ids.reader}/reopen`, { email: READER, body: {} }),
      'ALREADY_OPEN',
    );
    record(
      'resolve another',
      await call(`/api/comments/${ids.team}/resolve`, { email: READER, body: {} }),
      'FORBIDDEN',
    );
    record('status', await setStatus(READER, 'in_review', 0), 'FORBIDDEN');
    // Caps, seeded in the database rather than reached by hand.
    await env.DB.batch(Array.from({ length: 20 }, (_, n) => insertThread(READER, n)));
    record('own open cap', await comment(READER), 'TOO_MANY_OPEN');
    await env.DB.batch(Array.from({ length: 200 }, (_, n) => insertThread(OTHER, n)));
    record('page cap', await comment('new@initech.example'), 'PAGE_FULL');
    const insertReply = (author: string, n: number) =>
      env.DB.prepare(
        `INSERT INTO replies (site, id, thread_id, author, body, created_at) VALUES (?, ?, ?, ?, 'seeded', ?)`,
      ).bind(site, crypto.randomUUID(), ids.approver, author, new Date(at + n).toISOString());
    await env.DB.batch(Array.from({ length: 20 }, (_, n) => insertReply(READER, n)));
    record('own reply cap', await reply(ids.approver, READER), 'TOO_MANY_REPLIES');
    await env.DB.batch(Array.from({ length: 200 }, (_, n) => insertReply(TEAM, n)));
    record('thread cap', await reply(ids.approver, 'new@initech.example'), 'THREAD_FULL');
    await env.DB.batch(
      Array.from({ length: 30 }, () =>
        env.DB.prepare('INSERT INTO write_log (site, email, at) VALUES (?, ?, ?)').bind(site, READER, Date.now()),
      ),
    );
    record('rate limit', await comment(READER), 'RATE_LIMITED');
    for (const [name, body] of bodies) expect(leaks(body, [...IDENTITIES, ...TITLES]), name).toEqual([]);
  });

  it('30: every response is no-store', async () => {
    for (const path of [`/api/comments?${q}`, '/api/status', `/api/tickets?${q}`, '/api/pages']) {
      expect((await call(path, { email: READER })).headers.get('cache-control'), path).toBe('no-store');
    }
  });
});

describe('9: team label', () => {
  it('9: unset, it is "<org> team"; the hub label applies; a site label wins', async () => {
    await comment(TEAM, { body: 'from the team' });
    const author = async (override: Record<string, string>) =>
      ((await call(`/api/comments?${q}`, { email: READER, envOverride: override })).body as unknown as Thread[])[0]
        .author;
    expect(await author({})).toBe('acme team');
    expect(await author(configWith((c) => ({ ...c, teamLabel: 'Acme team' })))).toBe('Acme team');
    const both = configWith((c) => {
      (c.sites[0] as Record<string, unknown>).teamLabel = 'Sidecar crew';
      return { ...c, teamLabel: 'Acme team' };
    });
    expect(await author(both)).toBe('Sidecar crew');
  });
});
