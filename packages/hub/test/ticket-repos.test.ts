// #90: a site files tickets in several repos. A number in front matter is in
// the site's first (default) ticket repo; `<repo>#<number>` names another.
import { STATUS_LABEL } from '@specreview/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memoryStore } from '../src/store';
import {
  call,
  CONFIG,
  deps,
  github,
  installFetch,
  LIVE_HASH,
  manifests,
  PAGE,
  publishedFiles,
  reset,
  runCron,
  SIDECAR,
  WEB,
} from './helpers';

const TEAM = 'dev@acme.dev';
const READER = 'riya@initech.example';
type Ticket = { number: number; repo?: string; title?: string; url?: string; notLinked?: true };

// sidecar files in sidecar (default) and backend; web, same team, in sidecar
// and backend too unless a case says otherwise.
const configWith = (sidecarRepos: string[], webRepos: string[] = ['sidecar']) => {
  const cfg = structuredClone(CONFIG) as typeof CONFIG & { sites: Record<string, unknown>[] };
  delete (cfg.sites[0] as Record<string, unknown>).ticketRepo;
  cfg.sites[0].ticketRepos = sidecarRepos;
  delete (cfg.sites[1] as Record<string, unknown>).ticketRepo;
  cfg.sites[1].ticketRepos = webRepos;
  return { SPECREVIEW_CONFIG: JSON.stringify(cfg) };
};
const TWO = configWith(['sidecar', 'backend']);

const publishWith = (sidecarIssues: (number | string)[], webIssues: (number | string)[] = []) => {
  const all = manifests();
  all[SIDECAR].pages[PAGE].issues = sidecarIssues;
  all[WEB].pages[PAGE].issues = webIssues;
  deps.store = memoryStore(publishedFiles(all));
};

const ticketsAs = async (email: string, envOverride: Record<string, string>, site = SIDECAR) =>
  (await call(`/api/tickets?page=${encodeURIComponent(PAGE)}`, { email, site, envOverride }))
    .body as unknown as Ticket[];
const setStatus = (status: string, envOverride: Record<string, string>) =>
  call('/api/status', { email: TEAM, envOverride, body: { page: PAGE, status, expectedVersion: 0, hash: LIVE_HASH } });
const backend = () => github.repos.get('acme/backend')!;
const ours = (labels: string[]) => labels.filter((l) => l.startsWith('docs:'));

let spy: ReturnType<typeof installFetch>;
beforeEach(async () => {
  spy = installFetch();
  await reset();
  github.repos.set(
    'acme/backend',
    new Map([
      [4, { title: 'Queue worker', state: 'open', labels: [] }],
      [9, { title: 'Unrelated', state: 'open', labels: ['bug'] }],
    ]),
  );
});
afterEach(() => spy.mockRestore());

describe('90: tickets from each repo', () => {
  it('9, 18: a number is in the default repo, backend#4 in backend; each names its repo', async () => {
    publishWith([52, 'backend#4']);
    const team = await ticketsAs(TEAM, TWO);
    expect(team.map((t) => [t.repo, t.number, t.title])).toEqual([
      ['sidecar', 52, 'Company approval'],
      ['backend', 4, 'Queue worker'],
    ]);
    expect(team[1].url).toBe('https://github.com/acme/backend/issues/4');
    const reader = await ticketsAs(READER, TWO);
    expect(reader.map((t) => [t.repo, t.number, t.title, t.url])).toEqual([
      ['sidecar', 52, undefined, undefined],
      ['backend', 4, undefined, undefined],
    ]);
  });

  it('10: a site with one ticket repo names none, as before', async () => {
    publishWith([52], [52]);
    const web = await ticketsAs(TEAM, TWO, WEB);
    expect(web).toHaveLength(1);
    expect('repo' in web[0]).toBe(false);
  });

  it('11: a link to a repo the site no longer lists is not fetched', async () => {
    publishWith([52, 'backend#4']);
    const shrunk = configWith(['sidecar']);
    const t = await ticketsAs(TEAM, shrunk);
    expect(t[1]).toEqual({ number: 4, notLinked: true, repo: 'backend' });
    expect(github.calls.some((c) => c.includes('acme/backend'))).toBe(false);
  });
});

describe('90: the admin page', () => {
  it('17: the Sites tab lists every ticket repo of a site', async () => {
    const page = String((await call('/_admin/sites', { raw: true, email: 'owner@acme.dev', envOverride: TWO })).body);
    expect(page).toContain('tickets in acme/sidecar, acme/backend');
  });
});

describe('90: labels in each repo', () => {
  it('12: a status change labels the ticket in each repo, and nothing else there', async () => {
    publishWith([52, 'backend#4']);
    const r = await setStatus('in_review', TWO);
    expect(r.body).toMatchObject({ labels: 'updated' });
    // #52 is also linked from onboarding/approval, still pending.
    expect(ours(github.issues.get(52)!.labels)).toEqual([STATUS_LABEL.pending]);
    expect(ours(backend().get(4)!.labels)).toEqual([STATUS_LABEL.in_review]);
    expect(backend().get(9)!.labels).toEqual(['bug']);
  });

  it('13, 14: the cron labels backend links and clears our label from a backend ticket no page links', async () => {
    publishWith([52, 'backend#4']);
    backend().get(9)!.labels.push(STATUS_LABEL.ready);
    await runCron(TWO);
    expect(ours(backend().get(4)!.labels)).toEqual([STATUS_LABEL.pending]);
    expect(backend().get(9)!.labels).toEqual(['bug']);
    expect(ours(github.issues.get(52)!.labels)).toEqual([STATUS_LABEL.pending]);
  });

  it('15: a ticket two sites link carries the least advanced status of the two', async () => {
    const both = configWith(['sidecar', 'backend'], ['sidecar', 'backend']);
    publishWith([52, 'backend#4'], ['backend#4']);
    await setStatus('in_review', both);
    // web's page links backend#4 and is still pending.
    expect(ours(backend().get(4)!.labels)).toEqual([STATUS_LABEL.pending]);
  });

  it('11: a repo the config dropped is left alone by the sync', async () => {
    publishWith([52, 'backend#4']);
    await setStatus('in_review', configWith(['sidecar']));
    expect(backend().get(4)!.labels).toEqual([]);
    expect(github.calls.some((c) => c.includes('acme/backend'))).toBe(false);
  });
});
