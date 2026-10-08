import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memoryStore } from '../src/store';
import {
  call,
  comment,
  COMMIT_OLD,
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
  reconcile,
  reset,
  runCron,
  SIDECAR,
  TIKITI,
  token,
  WEB,
} from './helpers';

let spy: ReturnType<typeof installFetch>;
beforeEach(async () => {
  spy = installFetch();
  await reset();
});
afterEach(() => spy.mockRestore());

const READER = 'riya@ariai.example';
const TEAM = 'dev@inoltro.ai';
const APPROVER = 'approver@inoltro.ai';
const configWith = (patch: (c: typeof CONFIG) => unknown) => JSON.stringify(patch(structuredClone(CONFIG)));
const docsLabels = (repo: string, n: number) =>
  github.repos
    .get(repo)!
    .get(n)!
    .labels.filter((l) => l.startsWith('docs:'));
const setStatus = (site: string, email: string, status: string, expectedVersion: number, hash: string) =>
  call('/api/status', { site, email, body: { page: PAGE, status, expectedVersion, hash } });
const hashOf: Record<string, string> = { [SIDECAR]: LIVE_HASH, [WEB]: 'hash-web', [TIKITI]: 'hash-tikiti' };

describe('identity is per site', () => {
  it("7: a token for another hub's Access application is refused everywhere", async () => {
    const otherHub = await token({ email: TEAM, aud: 'aud-another-hub' });
    expect((await call('/api/me', { site: SIDECAR, token: otherHub })).status).toBe(401);
    expect((await call(`/_history/${COMMIT_OLD}/${PAGE}.md`, { site: SIDECAR, token: otherHub })).status).toBe(401);
  });

  it('M3, 6: team on one site may not read another site at all', async () => {
    expect((await call('/api/me', { site: SIDECAR, email: TEAM })).body).toMatchObject({ role: 'team' });
    const r = await call('/api/me', { site: TIKITI, email: TEAM });
    expect(r.status).toBe(403);
    expect(errorCode(r)).toBe('FORBIDDEN');
  });
});

describe('paths', () => {
  it('M2, M18: only an exact configured site prefix is a site; nothing else reveals anything', async () => {
    const bad = [
      '/',
      '/unknown/_api/me',
      '/sidecarevil/_api/me',
      '/Sidecar/_api/me',
      '/sidecar%2F_api/me',
      '/sidecar/_api',
      '//sidecar/_api/me',
      '/inoltrotech/sidecar/_api/me',
    ];
    for (const path of bad) {
      const r = await call(path, { email: TEAM });
      expect(r.status, path).toBe(404);
      expect(JSON.stringify(r.body), path).not.toMatch(/tikiti|sidecar|web/);
    }
    expect((await call('/sidecar', { email: TEAM })).status).toBe(404);
    expect((await call('/sidecar/', { email: TEAM })).status).toBe(200);
  });

  it('M17: history paths are strict; dot segments resolve before routing and stay behind sign-in', async () => {
    const odd = [
      `/sidecar/_history/${COMMIT_OLD.slice(0, 7)}/${PAGE}.md`,
      `/sidecar/_history//${PAGE}.md`,
      `/sidecar/_history/${COMMIT_OLD}/onboarding//signup.md`,
      `/sidecar/_history/${COMMIT_OLD}/onboarding%2Fsignup.md`,
      `/sidecar/_history/${COMMIT_OLD}/onboarding%5Csignup.md`,
      `/sidecar/_history/${COMMIT_OLD}/${PAGE}.txt`,
    ];
    for (const path of odd) expect((await call(path, { email: TEAM })).status, path).toBe(404);
    // URL parsing turns this into the site's own /_api/me, which still needs a token.
    const traversal = `/sidecar/_history/../_api/me`;
    expect((await call(traversal)).status).toBe(401);
    expect((await call(traversal, { email: TEAM })).body).toMatchObject({ email: TEAM });
    // A traversal cannot reach another site's history.
    // A traversal that lands on another site's history meets that site's
    // read rule: sidecar's team may not read tikiti.
    const across = `/sidecar/_history/${COMMIT_OLD}/../../../tikiti/_history/${COMMIT_OLD}/${PAGE}.md`;
    const r = await call(across, { raw: true, email: TEAM });
    expect(r.status).toBe(403);
    expect(String(r.body)).not.toContain('Tikiti only');
  });

  it('M11: the old paths are gone', async () => {
    for (const path of ['/api/me', '/_api/me', `/_history/${COMMIT_OLD}/${PAGE}.md`, '/inoltrotech/sidecar/_api/me']) {
      const r = await call(path, { raw: true, email: TEAM });
      expect(r.status, path).toBe(404);
    }
  });
});

describe('data is per site', () => {
  it('M5, M12: comments on the same page key are independent; a thread id does not cross sites', async () => {
    const a = await comment(READER, {}, SIDECAR);
    expect(a.status).toBe(201);
    const onWeb = await call(`/api/comments?page=${encodeURIComponent(PAGE)}`, { site: WEB, email: READER });
    expect(onWeb.body).toEqual([]);
    for (const action of ['replies', 'resolve', 'reopen']) {
      const body = action === 'replies' ? { body: 'x' } : {};
      const r = await call(`/api/comments/${a.body.id}/${action}`, { site: WEB, email: TEAM, body });
      expect(r.status, action).toBe(404);
    }
    const onSidecar = await call(`/api/comments?page=${encodeURIComponent(PAGE)}`, { site: SIDECAR, email: READER });
    expect(onSidecar.body).toEqual([expect.objectContaining({ state: 'open', replies: [] })]);
  });

  it('M13: caps and the ready guard count only their own site', async () => {
    for (let i = 0; i < 20; i++) expect((await comment(READER, { body: `a${i}` }, SIDECAR)).status).toBe(201);
    expect(errorCode(await comment(READER, { body: 'over' }, SIDECAR))).toBe('TOO_MANY_OPEN');
    expect((await comment(READER, { body: 'fine on web' }, WEB)).status).toBe(201);
    // Open comments on sidecar do not stop web's page from being ready.
    const web = await call(`/api/comments?page=${encodeURIComponent(PAGE)}`, { site: WEB, email: TEAM });
    const webThread = (web.body as unknown as { id: string }[])[0];
    await call(`/api/comments/${webThread.id}/resolve`, { site: WEB, email: TEAM, body: {} });
    const r = await setStatus(WEB, 'webpm@inoltro.ai', 'ready', 0, hashOf[WEB]);
    expect(r.status).toBe(200);
  });

  it('M14: each site has its own manifest; one missing does not affect another', async () => {
    const all = manifests();
    delete all[TIKITI];
    deps.store = memoryStore(publishedFiles(all));
    const missing = await call('/api/status', { site: TIKITI, email: 'x@tikiti.live' });
    expect(missing.status).toBe(503);
    expect(errorCode(missing)).toBe('SITE_NOT_PUBLISHED');
    const ok = await call('/api/status', { site: SIDECAR, email: READER });
    expect(ok.status).toBe(200);
    expect((ok.body as unknown as { page: string }[]).map((p) => p.page).sort()).toEqual([
      'index',
      'onboarding/approval',
      PAGE,
    ]);
    const web = await call('/api/status', { site: WEB, email: READER });
    expect((web.body as unknown as { hash: string }[])[0].hash).toBe('hash-web');
  });

  it('M15: status rows for the same page key are per site', async () => {
    await setStatus(SIDECAR, TEAM, 'in_review', 0, LIVE_HASH);
    const web = await call('/api/status', { site: WEB, email: READER });
    expect(web.body).toEqual([expect.objectContaining({ page: PAGE, status: 'pending', version: 0 })]);
    const rows = await env.DB.prepare('SELECT site, page FROM page_status').all();
    expect(rows.results).toEqual([{ site: keyOf(SIDECAR), page: PAGE }]);
  });

  it('M16: the rate limit is per site', async () => {
    const a = await comment(TEAM, { body: 'a' }, SIDECAR);
    const b = await comment(TEAM, { body: 'b' }, SIDECAR);
    for (let i = 0; i < 28; i++) {
      const id = i % 2 === 0 ? a.body.id : b.body.id;
      expect((await call(`/api/comments/${id}/replies`, { email: READER, body: { body: `n${i}` } })).status).toBe(201);
    }
    expect((await comment(READER, { body: 'two more' }, SIDECAR)).status).toBe(201);
    expect((await comment(READER, { body: 'two more' }, SIDECAR)).status).toBe(201);
    expect((await comment(READER, { body: 'one too many' }, SIDECAR)).status).toBe(429);
    expect((await comment(READER, { body: 'fine on web' }, WEB)).status).toBe(201);
  });
});

describe('labels across sites', () => {
  // web links #52 too, in the same ticket repo as sidecar; tikiti has its own #52.
  beforeEach(() => {
    deps.store = memoryStore(publishedFiles(manifests([52])));
  });

  it('M6, M19: the immediate label is the least advanced across sites, before any cron', async () => {
    const approval = { page: 'onboarding/approval', hash: 'hash-approval' };
    await call('/api/status', { email: APPROVER, body: { ...approval, status: 'ready', expectedVersion: 0 } });
    await setStatus(SIDECAR, APPROVER, 'ready', 0, LIVE_HASH);
    expect(docsLabels('inoltrotech/sidecar', 52)).toEqual(['docs: pending']);
    await setStatus(WEB, 'webpm@inoltro.ai', 'ready', 0, hashOf[WEB]);
    expect(docsLabels('inoltrotech/sidecar', 52)).toEqual(['docs: ready to build']);
    // A late comment on web demotes it and the shared ticket at once.
    expect((await comment(READER, {}, WEB)).status).toBe(201);
    expect(docsLabels('inoltrotech/sidecar', 52)).toEqual(['docs: in review']);
    // Only web's page was demoted; sidecar's page with the same key stays ready.
    const statuses = await env.DB.prepare('SELECT site, status FROM page_status WHERE page = ? ORDER BY site')
      .bind(PAGE)
      .all();
    expect(statuses.results).toEqual([
      { site: keyOf(SIDECAR), status: 'ready' },
      { site: keyOf(WEB), status: 'in_review' },
    ]);
    // tikiti's #52 is a different ticket and was never touched.
    expect(docsLabels('inoltrotech/tikiti', 52)).toEqual([]);
  });

  it('M8, M20: the cron reconciles every ticket repo, and one failing repo stops nothing else', async () => {
    await setStatus(TIKITI, 'pm@tikiti.live', 'ready', 0, hashOf[TIKITI]);
    github.repos.get('inoltrotech/sidecar')!.set(99, { title: 'stray', state: 'open', labels: ['docs: in review'] });
    github.repos.get('inoltrotech/tikiti')!.set(7, { title: 'stray', state: 'open', labels: ['docs: pending'] });
    github.downRepos.add('inoltrotech/sidecar');
    const results = await reconcile();
    expect(results).toEqual({ 'inoltrotech/sidecar': 'failed', 'inoltrotech/tikiti': 'updated' });
    expect(docsLabels('inoltrotech/tikiti', 52)).toEqual(['docs: ready to build']);
    expect(docsLabels('inoltrotech/tikiti', 7)).toEqual([]);
    // Nothing was cleared in the repo that could not be read.
    expect(docsLabels('inoltrotech/sidecar', 99)).toEqual(['docs: in review']);
    github.downRepos.clear();
    await runCron();
    expect(docsLabels('inoltrotech/sidecar', 99)).toEqual([]);
  });

  it('M21: a site files tickets in its ticketRepo, not its own repo', async () => {
    const tickets = await call(`/api/tickets?page=${encodeURIComponent(PAGE)}`, { site: WEB, email: READER });
    expect((tickets.body as unknown as { number: number; title: string }[])[0]).toMatchObject({
      number: 52,
      title: 'Company approval',
    });
    expect(github.calls.every((c) => !c.includes('/repos/inoltrotech/web/'))).toBe(true);
  });

  it('M9, M22: no token gives "unavailable", or the stale copy when one is cached', async () => {
    await call(`/api/tickets?page=${encodeURIComponent(PAGE)}`, { email: READER });
    await env.DB.prepare('UPDATE ticket_cache SET fetched_at = 0').run();
    deps.github = { tokenFor: async () => null };
    const [a] = (await call(`/api/tickets?page=${encodeURIComponent(PAGE)}`, { email: READER })).body as unknown as {
      stale?: boolean;
      title?: string;
    }[];
    expect(a).toMatchObject({ title: 'Company approval', stale: true });
    await env.DB.prepare('DELETE FROM ticket_cache').run();
    const [b] = (await call(`/api/tickets?page=${encodeURIComponent(PAGE)}`, { email: READER })).body as unknown[];
    expect(b).toEqual({ number: 52, unavailable: true });
    const r = await setStatus(SIDECAR, TEAM, 'in_review', 0, LIVE_HASH);
    expect(r.body).toMatchObject({ labels: 'failed' });
  });
});

describe('config', () => {
  it('M7: an invalid config refuses every request with CONFIG_INVALID', async () => {
    const r = await call('/api/me', {
      email: TEAM,
      envOverride: { SPECREVIEW_CONFIG: configWith((c) => ({ ...c, admins: [] })) },
    });
    expect(r.status).toBe(500);
    expect(errorCode(r)).toBe('CONFIG_INVALID');
    expect((await call('/api/me', { email: TEAM })).status).toBe(200);
  });

  it('M24: with an invalid config even / and unknown sites are 500, not 404', async () => {
    const broken = { SPECREVIEW_CONFIG: configWith((c) => ({ ...c, sites: [] })) };
    expect((await call('/', { envOverride: broken })).status).toBe(500);
    expect((await call('/no/_api/me', { envOverride: broken, raw: true })).status).toBe(500);
  });
});

describe('review fixes', () => {
  it('labels are created in a repo that has none, once', async () => {
    expect(github.labelDefs.get('inoltrotech/sidecar')).toBeUndefined();
    await setStatus(SIDECAR, TEAM, 'in_review', 0, LIVE_HASH);
    expect([...github.labelDefs.get('inoltrotech/sidecar')!].sort()).toEqual([
      'docs: in review',
      'docs: pending',
      'docs: ready to build',
    ]);
    // Checked once per isolate: the next sync asks GitHub about labels not at all.
    const labelCalls = () => github.calls.filter((c) => c.includes('/repos/inoltrotech/sidecar/labels')).length;
    const before = labelCalls();
    await setStatus(SIDECAR, TEAM, 'pending', 1, LIVE_HASH);
    expect(labelCalls()).toBe(before);
  });

  it('labels that cannot be created fail the sync instead of pretending', async () => {
    github.labelsMode = 'down';
    const r = await setStatus(SIDECAR, TEAM, 'in_review', 0, LIVE_HASH);
    expect(r.body).toMatchObject({ labels: 'failed' });
  });

  it('a 422 that is a validation error, not "already exists", fails the sync', async () => {
    github.labelsMode = 'invalid';
    const r = await setStatus(SIDECAR, TEAM, 'in_review', 0, LIVE_HASH);
    expect(r.body).toMatchObject({ labels: 'failed' });
  });

  it('a cron run that changes nothing keeps the cached ticket as the fallback when GitHub is down', async () => {
    await setStatus(SIDECAR, TEAM, 'in_review', 0, LIVE_HASH);
    await call(`/api/tickets?page=${encodeURIComponent(PAGE)}`, { email: READER });
    await runCron();
    github.down = true;
    const tickets = (await call(`/api/tickets?page=${encodeURIComponent(PAGE)}`, { email: READER }))
      .body as unknown as {
      number: number;
      stale?: boolean;
      unavailable?: boolean;
    }[];
    expect(tickets.find((t) => t.number === 23)).toMatchObject({ number: 23 });
    expect(tickets.find((t) => t.number === 23)?.unavailable).toBeUndefined();
  });

  it('the ticket box shows the new label straight after a status change', async () => {
    await call(`/api/tickets?page=${encodeURIComponent(PAGE)}`, { email: READER });
    await setStatus(SIDECAR, TEAM, 'in_review', 0, LIVE_HASH);
    // #23 is linked only from this page (#52 also from the pending approval page).
    const tickets = (await call(`/api/tickets?page=${encodeURIComponent(PAGE)}`, { email: READER }))
      .body as unknown as {
      number: number;
      labels: string[];
    }[];
    expect(tickets.find((t) => t.number === 23)?.labels).toEqual(['docs: in review']);
  });

  it('the team can reopen a thread on a page that has been removed', async () => {
    const c = await comment(READER);
    await call(`/api/comments/${c.body.id}/resolve`, { email: TEAM, body: {} });
    const all = manifests();
    delete all[SIDECAR].pages[PAGE];
    deps.store = memoryStore(publishedFiles(all));
    const { forgetManifests } = await import('../src/manifest');
    forgetManifests();
    expect((await call(`/api/comments/${c.body.id}/reopen`, { email: TEAM, body: {} })).status).toBe(200);
  });
});
