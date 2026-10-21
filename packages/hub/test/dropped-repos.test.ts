// #155: our labels are cleared from a ticket repo once no site lists it.
// Case numbers are the ticket's test plan.
import { STATUS_LABEL } from '@specreview/shared';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
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
const DAY = 24 * 60 * 60_000;

// sidecar files in the given repos; web in sidecar unless a case says otherwise.
const configWith = (sidecarRepos: string[], webRepos: string[] = ['sidecar']) => {
  const cfg = structuredClone(CONFIG) as typeof CONFIG & { sites: Record<string, unknown>[] };
  delete (cfg.sites[0] as Record<string, unknown>).ticketRepo;
  cfg.sites[0].ticketRepos = sidecarRepos;
  delete (cfg.sites[1] as Record<string, unknown>).ticketRepo;
  cfg.sites[1].ticketRepos = webRepos;
  return { SPECREVIEW_CONFIG: JSON.stringify(cfg) };
};
const TWO = configWith(['sidecar', 'backend']);
const DROPPED = configWith(['sidecar']);

const publishWith = (sidecarIssues: (number | string)[], webIssues: (number | string)[] = []) => {
  const all = manifests();
  all[SIDECAR].pages[PAGE].issues = sidecarIssues;
  all[WEB].pages[PAGE].issues = webIssues;
  deps.store = memoryStore(publishedFiles(all));
};
const setStatus = (status: string, envOverride: Record<string, string>, expectedVersion = 0) =>
  call('/api/status', { email: TEAM, envOverride, body: { page: PAGE, status, expectedVersion, hash: LIVE_HASH } });

const backend = () => github.repos.get('acme/backend')!;
const ours = (labels: string[]) => labels.filter((l) => l.startsWith('docs:'));
type Row = { repo: string; labelled_at: number; failing_since: number | null };
const rowFor = (repo: string) =>
  env.DB.prepare('SELECT repo, labelled_at, failing_since FROM label_repos WHERE repo = ?').bind(repo).first<Row>();
const setRow = (repo: string, labelledAt: number, failingSince: number | null) =>
  env.DB.prepare('UPDATE label_repos SET labelled_at = ?, failing_since = ? WHERE repo = ?')
    .bind(labelledAt, failingSince, repo)
    .run();
const backendCalls = () => github.calls.filter((c) => c.includes('acme/backend'));
// Makes label_repos unusable for the length of `run`.
const withoutTable = async (run: () => Promise<void>) => {
  await env.DB.prepare('ALTER TABLE label_repos RENAME TO label_repos_hidden').run();
  try {
    await run();
  } finally {
    await env.DB.prepare('ALTER TABLE label_repos_hidden RENAME TO label_repos').run();
  }
};

let fetchSpy: ReturnType<typeof installFetch>;
let errors: MockInstance<typeof console.error>;
const lines = () => errors.mock.calls.map((args) => args.map(String).join(' '));
beforeEach(async () => {
  fetchSpy = installFetch();
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  await reset();
  github.repos.set(
    'acme/backend',
    new Map([
      [4, { title: 'Queue worker', state: 'open', labels: [] }],
      [9, { title: 'Unrelated', state: 'open', labels: ['bug'] }],
    ]),
  );
});
afterEach(() => {
  for (const line of lines()) for (const secret of ['test-write', 'test-read']) expect(line).not.toContain(secret);
  errors.mockRestore();
  fetchSpy.mockRestore();
});

// backend#4 labelled in review through a status change while backend is listed.
const labelBackend = async () => {
  publishWith([52, 'backend#4']);
  await setStatus('in_review', TWO);
  expect(ours(backend().get(4)!.labels)).toEqual([STATUS_LABEL.in_review]);
};

describe('155: a repo no site lists any more', () => {
  it('1, 2: the cron clears our labels there, leaves others, forgets it, then calls it no more', async () => {
    await labelBackend();
    backend().get(9)!.labels.push(STATUS_LABEL.ready);
    expect(await rowFor('acme/backend')).not.toBeNull();
    await runCron(DROPPED);
    expect(backend().get(4)!.labels).toEqual([]);
    expect(backend().get(9)!.labels).toEqual(['bug']);
    expect(await rowFor('acme/backend')).toBeNull();
    github.calls = [];
    await runCron(DROPPED);
    expect(backendCalls()).toEqual([]);
    expect(lines()).toEqual([]);
  });

  it('1: a label set after the clearing began keeps the repo for the next run', async () => {
    await labelBackend();
    await setRow('acme/backend', Date.now() + 60_000, null);
    await runCron(DROPPED);
    expect(backend().get(4)!.labels).toEqual([]);
    expect(await rowFor('acme/backend')).not.toBeNull();
  });

  it('3: a repo the hub never labelled is never called', async () => {
    publishWith([52, 'backend#4']);
    backend().get(9)!.labels.push(STATUS_LABEL.ready);
    await setStatus('in_review', DROPPED);
    await runCron(DROPPED);
    expect(backendCalls()).toEqual([]);
    expect(backend().get(9)!.labels).toEqual(['bug', STATUS_LABEL.ready]);
  });

  it('4: a failed clearing keeps the labels and the repo, logs one line, and the next run clears', async () => {
    await labelBackend();
    github.downRepos.add('acme/backend');
    const before = Date.now();
    await runCron(DROPPED);
    expect(ours(backend().get(4)!.labels)).toEqual([STATUS_LABEL.in_review]);
    const row = await rowFor('acme/backend');
    expect(row?.failing_since).toBeGreaterThanOrEqual(before);
    expect(lines().filter((l) => l.startsWith('label sync failed for acme/backend: '))).toHaveLength(1);
    // A second failure keeps the first failure's time.
    await runCron(DROPPED);
    expect((await rowFor('acme/backend'))?.failing_since).toBe(row?.failing_since);
    github.downRepos.clear();
    await runCron(DROPPED);
    expect(backend().get(4)!.labels).toEqual([]);
    expect(await rowFor('acme/backend')).toBeNull();
  });

  it('5: failing for over 7 days, the repo is forgotten and the line says to remove the labels by hand', async () => {
    await labelBackend();
    await setRow('acme/backend', Date.now() - 9 * DAY, Date.now() - 8 * DAY);
    github.downRepos.add('acme/backend');
    await runCron(DROPPED);
    expect(await rowFor('acme/backend')).toBeNull();
    const line = lines().find((l) => l.startsWith('label sync failed for acme/backend: '));
    expect(line).toContain('remove its labels by hand');
  });

  it('5: under 7 days of failures, the repo is kept', async () => {
    await labelBackend();
    await setRow('acme/backend', Date.now() - 9 * DAY, Date.now() - 6 * DAY);
    github.downRepos.add('acme/backend');
    await runCron(DROPPED);
    expect(await rowFor('acme/backend')).not.toBeNull();
  });

  it('5: a label set after a week-old failing clearing began keeps the repo, and no line says it was forgotten', async () => {
    await labelBackend();
    await setRow('acme/backend', Date.now() + 60_000, Date.now() - 8 * DAY);
    github.downRepos.add('acme/backend');
    await runCron(DROPPED);
    expect(await rowFor('acme/backend')).not.toBeNull();
    expect(lines().some((l) => l.includes('remove its labels by hand'))).toBe(false);
  });

  it('1: a sync records again after its label writes, so a clearing begun meanwhile keeps the repo', async () => {
    publishWith([52, 'backend#4']);
    vi.useFakeTimers({ toFake: ['Date'] });
    let wroteAt = 0;
    github.answer = (method, repo, path) => {
      if (method === 'POST' && repo === 'acme/backend' && path === '/issues/4/labels') {
        vi.setSystemTime(Date.now() + 5_000);
        wroteAt = Date.now();
      }
      return null;
    };
    try {
      await setStatus('in_review', TWO);
    } finally {
      vi.useRealTimers();
    }
    expect(wroteAt).toBeGreaterThan(0);
    expect((await rowFor('acme/backend'))?.labelled_at).toBeGreaterThanOrEqual(wroteAt);
  });

  it('1: a listed repo no page links is recorded, so labels it kept are cleared once it is dropped', async () => {
    publishWith([52]);
    backend().get(9)!.labels.push(STATUS_LABEL.ready);
    github.downRepos.add('acme/backend');
    await runCron(TWO);
    expect(backend().get(9)!.labels).toEqual(['bug', STATUS_LABEL.ready]);
    expect(await rowFor('acme/backend')).not.toBeNull();
    github.downRepos.clear();
    await runCron(DROPPED);
    expect(backend().get(9)!.labels).toEqual(['bug']);
    expect(await rowFor('acme/backend')).toBeNull();
  });

  it('5: a repo listed again forgets an earlier failure to clear it', async () => {
    await labelBackend();
    await setRow('acme/backend', 1, Date.now() - 8 * DAY);
    await runCron(TWO);
    expect((await rowFor('acme/backend'))?.failing_since).toBeNull();
  });

  it('7: a repo listed again before the cron is reconciled as usual', async () => {
    await labelBackend();
    await runCron(TWO);
    expect(ours(backend().get(4)!.labels)).toEqual([STATUS_LABEL.in_review]);
    expect(await rowFor('acme/backend')).not.toBeNull();
  });

  it('8: a repo another site still lists keeps the labels its pages give', async () => {
    publishWith([52, 'backend#4'], ['backend#4']);
    await setStatus('in_review', configWith(['sidecar', 'backend'], ['sidecar', 'backend']));
    await runCron(configWith(['sidecar'], ['sidecar', 'backend']));
    // web's page links backend#4 and is pending.
    expect(ours(backend().get(4)!.labels)).toEqual([STATUS_LABEL.pending]);
    expect(await rowFor('acme/backend')).not.toBeNull();
  });
});

describe('155: recording the repos the hub labels', () => {
  it('9: a status change records its repo and clears an earlier failure', async () => {
    await labelBackend();
    await setRow('acme/backend', 1, Date.now() - DAY);
    const before = Date.now();
    expect((await setStatus('pending', TWO, 1)).body).toMatchObject({ labels: 'updated' });
    const row = await rowFor('acme/backend');
    expect(row?.labelled_at).toBeGreaterThanOrEqual(before);
    expect(row?.failing_since).toBeNull();
  });

  it('11: a repo with no linked tickets is not recorded', async () => {
    publishWith([52]);
    await setStatus('in_review', TWO);
    expect(await rowFor('acme/sidecar')).not.toBeNull();
    expect(await rowFor('acme/backend')).toBeNull();
  });

  it('6: when the record cannot be written, no label is written and the sync fails', async () => {
    publishWith([52, 'backend#4']);
    await withoutTable(async () => {
      const r = await setStatus('in_review', TWO);
      expect(r.body).toMatchObject({ labels: 'failed' });
    });
    expect(backend().get(4)!.labels).toEqual([]);
    expect(lines().some((l) => l.includes('recording acme/backend as labelled failed'))).toBe(true);
  });

  it('10: when the recorded repos cannot be read, the listed repos are still reconciled', async () => {
    publishWith([52, 'backend#4']);
    await withoutTable(() => runCron(TWO));
    // Each listed repo is visited and fails on its own record; the unreadable
    // list is reported once.
    for (const repo of ['acme/sidecar', 'acme/backend'])
      expect(lines()).toContain(
        `label sync failed for ${repo}: recording ${repo} as labelled failed (Error: D1_ERROR: no such table: label_repos: SQLITE_ERROR)`,
      );
    expect(lines().filter((l) => l.startsWith('label sync could not read the repos it has labelled'))).toHaveLength(1);
  });
});
