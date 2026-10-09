import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { call, github, installFetch, LIVE_HASH, PAGE, reconcile, reset, runCron } from './helpers';

let spy: ReturnType<typeof installFetch>;
beforeEach(async () => {
  spy = installFetch();
  await reset();
});
afterEach(() => spy.mockRestore());

const READER = 'riya@initech.example';
const TEAM = 'dev@acme.dev';
type Ticket = { number: number; title?: string; stale?: boolean; unavailable?: true; notFound?: true };
const tickets = async () =>
  (await call(`/api/tickets?page=${encodeURIComponent(PAGE)}`, { email: TEAM })).body as unknown as Ticket[];

describe('22: tickets box', () => {
  it('fresh from GitHub, then served from the cache without a call', async () => {
    expect((await tickets()).map((t) => [t.number, t.title])).toEqual([
      [52, 'Company approval'],
      [23, 'Join links'],
    ]);
    const before = github.calls.length;
    await tickets();
    expect(github.calls.length).toBe(before);
  });

  it('GitHub down with a cache shows the cached copy as stale; with no cache, unavailable', async () => {
    await tickets();
    await env.DB.prepare('UPDATE ticket_cache SET fetched_at = 0 WHERE number = 52').run();
    await env.DB.prepare('DELETE FROM ticket_cache WHERE number = 23').run();
    github.down = true;
    const [a, b] = await tickets();
    expect(a).toMatchObject({ number: 52, title: 'Company approval', stale: true });
    expect(b).toEqual({ number: 23, unavailable: true });
  });

  it('23: a linked ticket that does not exist is shown as not found', async () => {
    github.issues.delete(23);
    expect((await tickets())[1]).toEqual({ number: 23, notFound: true });
  });

  it('41: the page parameter decides the tickets; a request cannot name one', async () => {
    const r = await call(`/api/tickets?page=${encodeURIComponent(PAGE)}&issue=999`, { email: READER });
    expect((r.body as unknown as Ticket[]).map((t) => t.number)).toEqual([52, 23]);
    expect(github.calls.some((c) => c.includes('/999'))).toBe(false);
    expect((await call('/api/tickets?page=onboarding%2Fnope', { email: READER })).status).toBe(400);
  });
});

describe('40: label reconciliation', () => {
  const docsLabels = (n: number) => github.issues.get(n)!.labels.filter((l) => l.startsWith('docs:'));
  const setStatus = (email: string, status: string, expectedVersion: number) =>
    call('/api/status', { email, body: { page: PAGE, status, expectedVersion, hash: LIVE_HASH } });

  it('one ticket failing is repaired by the next cron run', async () => {
    github.failWritesFor.add(23);
    const r = await setStatus('dev@acme.dev', 'in_review', 0);
    expect(r.body).toMatchObject({ labels: 'failed' });
    expect(docsLabels(23)).toEqual([]);
    github.failWritesFor.clear();
    await runCron();
    expect(docsLabels(23)).toEqual(['docs: in review']);
  });

  it('an older sync finishing late is overwritten by the next run; tickets end on the newest status', async () => {
    await setStatus('dev@acme.dev', 'in_review', 0);
    // Labels left in a stale state, as a late older sync would leave them.
    github.issues.get(23)!.labels = ['docs: pending', 'docs: in review', 'enhancement'];
    await setStatus('approver@acme.dev', 'ready', 1);
    expect(docsLabels(23)).toEqual(['docs: ready to build']);
    github.issues.get(23)!.labels = ['docs: pending'];
    await runCron();
    expect(docsLabels(23)).toEqual(['docs: ready to build']);
  });

  it('a page changed after ready is relabelled in review by the cron', async () => {
    await setStatus('approver@acme.dev', 'ready', 0);
    await env.DB.prepare("UPDATE page_status SET ready_hash = 'older'").run();
    await runCron();
    expect(docsLabels(23)).toEqual(['docs: in review']);
  });
});

describe('reconcile is stable', () => {
  it('a second cron run with nothing changed writes nothing', async () => {
    await call('/api/status', {
      email: 'approver@acme.dev',
      body: { page: PAGE, status: 'ready', expectedVersion: 0, hash: LIVE_HASH },
    });
    await runCron();
    const before = github.calls.length;
    await runCron();
    const writes = github.calls.slice(before).filter((c) => !c.startsWith('GET'));
    expect(writes).toEqual([]);
  });
});

describe('tickets no page links any more', () => {
  it('lose our label on the next cron run; linked tickets keep theirs', async () => {
    github.issues.set(99, { title: 'Dropped from a page', state: 'closed', labels: ['bug', 'docs: ready to build'] });
    await runCron();
    expect(github.issues.get(99)!.labels).toEqual(['bug']);
    expect(github.issues.get(52)!.labels).toContain('docs: pending');
  });

  it('a failure listing labelled tickets is reported as failed', async () => {
    github.down = true;
    expect((await reconcile())['acme/sidecar']).toBe('failed');
  });
});

describe('readers see only our labels', () => {
  it("a ticket's other labels are not sent", async () => {
    github.issues.get(52)!.labels = ['security', 'docs: pending'];
    const res = await call(`/api/tickets?page=${encodeURIComponent(PAGE)}`, { email: 'riya@initech.example' });
    const [t] = res.body as unknown as { labels: string[] }[];
    expect(t.labels).toEqual(['docs: pending']);
  });
});

describe('stray labels beyond the first page of results', () => {
  it('are all cleared', async () => {
    for (let n = 1000; n < 1150; n++)
      github.issues.set(n, { title: 't', state: 'closed', labels: ['docs: in review'] });
    await runCron();
    const left = [...github.issues.entries()].filter(([n, i]) => n >= 1000 && i.labels.length > 0);
    expect(left).toEqual([]);
  });
});
