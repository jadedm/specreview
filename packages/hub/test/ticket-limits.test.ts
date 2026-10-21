// #176: a page's ticket lookups and a sync's label writes run a few at a time,
// and a ticket GitHub does not have is remembered like one it has.
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TICKET_CALLS_AT_ONCE, TICKET_TTL_MS } from '../src/github';
import { eachLimited } from '../src/limited';
import { memoryStore } from '../src/store';
import { call, deps, github, installFetch, manifests, PAGE, publishedFiles, reset, runCron, SIDECAR } from './helpers';

let spy: ReturnType<typeof installFetch>;
// The limit the ticket asks for, written here rather than read from the code.
const AT_ONCE = 5;
// Ticket reads and label removals in flight at once, at most, while the
// stand-in answers slowly.
type Kind = 'read' | 'remove';
const kindOf = (req: Request): Kind | null => {
  const path = new URL(req.url).pathname;
  if (req.method === 'GET' && /\/issues\/\d+$/.test(path)) return 'read';
  if (req.method === 'DELETE' && /\/issues\/\d+\/labels\//.test(path)) return 'remove';
  return null;
};
let inFlight: Record<Kind, number> = { read: 0, remove: 0 };
let most: Record<Kind, number> = { read: 0, remove: 0 };
beforeEach(async () => {
  spy = installFetch();
  const answer = spy.getMockImplementation()!;
  spy.mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    const kind = new URL(req.url).host === 'api.github.com' ? kindOf(req) : null;
    if (!kind) return answer(input, init);
    inFlight[kind]++;
    most[kind] = Math.max(most[kind], inFlight[kind]);
    try {
      await new Promise((resolve) => setTimeout(resolve, 2));
      return await answer(input, init);
    } finally {
      inFlight[kind]--;
    }
  });
  await reset();
  inFlight = { read: 0, remove: 0 };
  most = { read: 0, remove: 0 };
});
afterEach(() => spy.mockRestore());

const TEAM = 'dev@acme.dev';
const NUMBERS = Array.from({ length: 20 }, (_, i) => 100 + i);
type Ticket = { number: number; title?: string; notFound?: true };

const publishLinks = (issues: number[]) => {
  const all = manifests();
  all[SIDECAR].pages[PAGE].issues = issues;
  deps.store = memoryStore(publishedFiles(all));
};
const tickets = async () =>
  (await call(`/api/tickets?page=${encodeURIComponent(PAGE)}`, { email: TEAM })).body as unknown as Ticket[];
const issueReads = (n: number) => github.calls.filter((c) => c === `GET /repos/acme/sidecar/issues/${n}`).length;

describe('#176: ticket lookups', () => {
  it('5: a page of 20 links reads at most 5 tickets at once and answers all 20 in link order', async () => {
    for (const n of NUMBERS) github.issues.set(n, { title: `T${n}`, state: 'open', labels: [] });
    publishLinks(NUMBERS);
    const got = await tickets();
    expect(got.map((t) => [t.number, t.title])).toEqual(NUMBERS.map((n) => [n, `T${n}`]));
    expect(TICKET_CALLS_AT_ONCE).toBe(AT_ONCE);
    expect(most.read).toBe(AT_ONCE);
  });

  it('6: a ticket GitHub does not have is not asked for again within the cache time', async () => {
    publishLinks([52, 404]);
    expect((await tickets())[1]).toEqual({ number: 404, notFound: true });
    expect(issueReads(404)).toBe(1);
    expect((await tickets())[1]).toEqual({ number: 404, notFound: true });
    expect(issueReads(404)).toBe(1);
  });

  it('7: once the cache time has passed it is asked again; found, it is shown and no longer remembered as missing', async () => {
    publishLinks([52, 404]);
    await tickets();
    await env.DB.prepare('UPDATE ticket_missing SET fetched_at = ?')
      .bind(Date.now() - TICKET_TTL_MS - 1)
      .run();
    github.issues.set(404, { title: 'Made since', state: 'open', labels: [] });
    expect((await tickets())[1]).toMatchObject({ number: 404, title: 'Made since' });
    expect(issueReads(404)).toBe(2);
    expect((await env.DB.prepare('SELECT * FROM ticket_missing').all()).results).toEqual([]);
  });
});

describe('#176: a build published before the limit', () => {
  it('a page linking 25 tickets is still served and its tickets read, 5 at a time', async () => {
    const many = Array.from({ length: 25 }, (_, i) => 200 + i);
    for (const n of many) github.issues.set(n, { title: `T${n}`, state: 'open', labels: [] });
    publishLinks(many);
    const pages = await call('/api/pages', { email: TEAM });
    expect(pages.status).toBe(200);
    expect((await tickets()).map((t) => t.number)).toEqual(many);
    expect(most.read).toBe(AT_ONCE);
  });
});

describe('#176: label syncs', () => {
  it('8: the cron labels every linked ticket, reading at most 5 at once', async () => {
    for (const n of NUMBERS) github.issues.set(n, { title: `T${n}`, state: 'open', labels: [] });
    publishLinks(NUMBERS);
    await runCron();
    for (const n of NUMBERS) expect(github.issues.get(n)!.labels, String(n)).toEqual(['docs: pending']);
    expect(most.read).toBe(AT_ONCE);
  });

  it('8: tickets no page links lose our labels, at most 5 removals at once across all three labels', async () => {
    publishLinks([52]);
    const labels = ['docs: pending', 'docs: in review', 'docs: ready to build'];
    for (let n = 1000; n < 1030; n++) github.issues.set(n, { title: 't', state: 'closed', labels: [labels[n % 3]] });
    await runCron();
    const left = [...github.issues.entries()].filter(([n, i]) => n >= 1000 && i.labels.length > 0);
    expect(left).toEqual([]);
    expect(most.remove).toBe(AT_ONCE);
  });
});

describe('eachLimited', () => {
  it('keeps the order, never runs more than the limit, and takes an empty list', async () => {
    let now = 0;
    let peak = 0;
    const out = await eachLimited([5, 1, 4, 2, 3, 0, 6], 3, async (n) => {
      now++;
      peak = Math.max(peak, now);
      await new Promise((resolve) => setTimeout(resolve, n));
      now--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30, 0, 60]);
    expect(peak).toBe(3);
    expect(await eachLimited([], 3, async () => 1)).toEqual([]);
  });

  it('rejects with the first failure, and the other workers start nothing after it', async () => {
    const started: number[] = [];
    await expect(
      eachLimited([1, 2, 3, 4, 5, 6], 2, async (n) => {
        started.push(n);
        if (n === 2) throw new Error('two');
        await new Promise((resolve) => setTimeout(resolve, 1));
        return n;
      }),
    ).rejects.toThrow('two');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started).toEqual([1, 2]);
  });
});
