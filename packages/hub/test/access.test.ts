import { env as workerEnv } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appStub, call, CONFIG, github, HOST, installFetch, reset } from './helpers';

// Editing readers and approvers from the admin page (#12): each change is a
// commit to the config repo (a stand-in here keeps the file and its sha), and
// a removal counts at once through pending_removals.
const ADMIN = 'owner@acme.dev';
const APP_ID = '424242';
const keys = (await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true,
  ['sign', 'verify'],
)) as CryptoKeyPair;
const pkcs8 = new Uint8Array((await crypto.subtle.exportKey('pkcs8', keys.privateKey)) as ArrayBuffer);
const PEM = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs8))
  .match(/.{1,64}/g)!
  .join('\n')}\n-----END PRIVATE KEY-----\n`;

const { accessTeamDomain: _t, accessAud: _a, ...orgFile } = CONFIG as Record<string, unknown>;
// The live config: sidecar also lets one exact reader in.
const LIVE = {
  ...CONFIG,
  configRepo: 'docs-hub',
  sites: (CONFIG.sites as Record<string, unknown>[]).map((s) =>
    s.repo === 'sidecar' ? { ...s, readers: ['@initech.example', 'ana@partner.example'] } : s,
  ),
};
const envFor = (config: unknown = LIVE) => ({
  SPECREVIEW_CONFIG: JSON.stringify(config),
  GITHUB_APP_ID: APP_ID,
  GITHUB_APP_PRIVATE_KEY: PEM,
});
const env = envFor();

const b64 = (t: string) => btoa(String.fromCharCode(...new TextEncoder().encode(t)));
const unb64 = (t: string) => new TextDecoder().decode(Uint8Array.from(atob(t), (c) => c.charCodeAt(0)));
type Put = { message: string; author: { name: string; email: string }; sha: string; branch: string };
let file: { sha: string; text: string };
let puts: Put[];
let seq = 0;
// What the next PUTs do: 'ok', a status to answer, 'lost' (applied, no answer),
// 'refused-lost' (not applied, no answer).
let next: (number | 'ok' | 'lost' | 'refused-lost')[];
let reads: 'ok' | 'down';

const configText = (c: Record<string, unknown>) => `${JSON.stringify(c, null, 2)}\n`;
const fileConfig = () => JSON.parse(file.text) as { sites: Record<string, unknown>[] };
const siteIn = (repo: string) => fileConfig().sites.find((s) => s.repo === repo)!;

const standIn = async (req: Request, repo: string, path: string): Promise<Response | null> => {
  if (repo !== 'acme/docs-hub') return null;
  const u = new URL(`http://x${path || '/'}`);
  if (reads === 'down' && req.method === 'GET') return new Response('down', { status: 503 });
  if (u.pathname === '/' && req.method === 'GET') return Response.json({ id: 4001, default_branch: 'main' });
  if (u.pathname === '/contents/specreview.config.json' && req.method === 'GET')
    return Response.json({ sha: file.sha, content: b64(file.text) });
  if (u.pathname === '/contents/specreview.config.json' && req.method === 'PUT') {
    const body = (await req.json()) as Put & { content: string };
    puts.push(body);
    const what = next.shift() ?? 'ok';
    if (typeof what === 'number') return Response.json({ message: 'no' }, { status: what });
    if (what === 'refused-lost') throw new TypeError('network down');
    if (body.sha !== file.sha) return Response.json({ message: 'sha mismatch' }, { status: 409 });
    file = { sha: `sha${++seq}`, text: unb64(body.content) };
    if (what === 'lost') throw new TypeError('network down');
    return Response.json({ content: { sha: file.sha } }, { status: 200 });
  }
  return null;
};

let spy: ReturnType<typeof installFetch>;
beforeEach(async () => {
  spy = installFetch();
  await reset();
  const { configRepo: _c, ...withoutRepo } = LIVE;
  void withoutRepo;
  file = { sha: 'sha0', text: configText({ ...orgFile, configRepo: 'docs-hub', sites: LIVE.sites }) };
  puts = [];
  next = [];
  reads = 'ok';
  github.repoApi = standIn;
  github.app = appStub(APP_ID, keys.publicKey);
  github.app.installations.set('acme/docs-hub', 7);
});
afterEach(() => {
  spy.mockRestore();
  vi.restoreAllMocks();
});

const change = (
  fields: Record<string, string>,
  opts: { email?: string; origin?: string; envOverride?: Record<string, string | undefined> } = {},
) =>
  call('/_admin/access', {
    raw: true,
    method: 'POST',
    email: opts.email ?? ADMIN,
    envOverride: opts.envOverride ?? env,
    rawBody: new URLSearchParams(fields).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: opts.origin ?? HOST },
  });
const html = (r: { body: unknown }) => r.body as unknown as string;
const add = (list: string, entry: string, site = 'sidecar') => change({ site, list, action: 'add', entry });
const remove = (list: string, entry: string, site = 'sidecar') => change({ site, list, action: 'remove', entry });
const status = async (email: string, envOverride = env) =>
  (await call('/api/me', { email, envOverride, site: 'sidecar' })).status;
const roleOf = async (email: string) =>
  ((await call('/api/me', { email, envOverride: env, site: 'sidecar' })).body as { role?: string }).role;
const pendingRows = async () =>
  (await workerEnv.DB.prepare('SELECT site, list, entry FROM pending_removals').all()).results;

describe('1: who may change the lists', () => {
  it('a non-admin, another origin, no app or no config repo: refused, nothing written', async () => {
    expect(
      (
        await change(
          { site: 'sidecar', list: 'readers', action: 'add', entry: 'x@y.example' },
          { email: 'dev@acme.dev' },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await change(
          { site: 'sidecar', list: 'readers', action: 'add', entry: 'x@y.example' },
          { origin: 'https://evil.example' },
        )
      ).status,
    ).toBe(403);
    const noApp = await change(
      { site: 'sidecar', list: 'readers', action: 'add', entry: 'x@y.example' },
      { envOverride: { ...env, GITHUB_APP_ID: undefined, GITHUB_APP_PRIVATE_KEY: undefined } },
    );
    expect(noApp.status).toBe(409);
    const noRepo = await change(
      { site: 'sidecar', list: 'readers', action: 'add', entry: 'x@y.example' },
      { envOverride: envFor(CONFIG) },
    );
    expect(noRepo.status).toBe(409);
    expect(puts).toEqual([]);
  });

  it('a malformed form is refused', async () => {
    for (const fields of [
      { site: 'nope', list: 'readers', action: 'add', entry: 'x@y.example' },
      { site: 'sidecar', list: 'admins', action: 'add', entry: 'x@y.example' },
      { site: 'sidecar', list: 'readers', action: 'wipe', entry: 'x@y.example' },
      { site: 'sidecar', list: 'readers', action: 'add', entry: '' },
    ]) {
      expect((await change(fields)).status).toBe(400);
    }
    expect(puts).toEqual([]);
  });
});

describe('2 to 4 and 12: adding', () => {
  it('2: one commit adds the reader to that site only, requested by the admin', async () => {
    const before = fileConfig();
    const r = await add('readers', 'New@Partner.example');
    expect(r.status).toBe(200);
    expect(html(r)).toContain('new@partner.example added to sidecar');
    expect(puts).toHaveLength(1);
    expect(puts[0].author).toEqual({ name: ADMIN, email: ADMIN });
    expect(puts[0].message).toBe(
      "chore(config): add reader new@partner.example to sidecar\n\nRequested by owner@acme.dev on the hub's admin page.",
    );
    expect(puts[0].sha).toBe('sha0');
    const after = fileConfig();
    expect(siteIn('sidecar').readers).toEqual(['@initech.example', 'ana@partner.example', 'new@partner.example']);
    expect({ ...after, sites: after.sites.filter((s) => s.repo !== 'sidecar') }).toEqual({
      ...before,
      sites: before.sites.filter((s) => s.repo !== 'sidecar'),
    });
  });

  it('3: a domain reader and an approver at a team domain are added; an approver elsewhere is refused unwritten', async () => {
    expect((await add('readers', '@globex.example')).status).toBe(200);
    expect((await add('approvers', 'lead@acme.dev')).status).toBe(200);
    expect(siteIn('sidecar').approvers).toEqual(['approver@acme.dev', 'lead@acme.dev']);
    const r = await add('approvers', 'boss@elsewhere.example');
    expect(r.status).toBe(400);
    expect(html(r)).toContain('approvers');
    expect(puts).toHaveLength(2);
  });

  it('4: an entry the config rules refuse is not written', async () => {
    for (const entry of ['@gmail.com', 'not-an-email']) {
      const r = await add('readers', entry);
      expect(r.status).toBe(400);
    }
    expect(puts).toEqual([]);
  });

  it('12: adding what is there or removing what is not writes nothing', async () => {
    const a = await add('readers', 'ana@partner.example');
    expect(html(a)).toContain('ana@partner.example is already listed');
    const b = await remove('readers', 'nobody@partner.example');
    expect(html(b)).toContain('nobody@partner.example is not listed');
    expect(puts).toEqual([]);
    // A removal is recorded first whatever the file says; for an unlisted entry it refuses no one.
    expect(await pendingRows()).toEqual([{ site: 'acme/sidecar', list: 'readers', entry: 'nobody@partner.example' }]);
  });
});

describe('5 to 9: removals count at once', () => {
  it('5: a removed reader is refused on the next request although the live config still lists them', async () => {
    expect(await status('ana@partner.example')).toBe(200);
    const r = await remove('readers', 'ana@partner.example');
    expect(r.status).toBe(200);
    expect(siteIn('sidecar').readers).toEqual(['@initech.example']);
    expect(await status('ana@partner.example')).toBe(403);
    expect(await pendingRows()).toEqual([{ site: 'acme/sidecar', list: 'readers', entry: 'ana@partner.example' }]);
  });

  it('6: removing a domain refuses everyone there at once; the team is unaffected', async () => {
    await remove('readers', '@initech.example');
    expect(await status('riya@initech.example')).toBe(403);
    expect(await status('dev@acme.dev')).toBe(200);
  });

  it('7: a removed approver is team at once', async () => {
    expect(await roleOf('approver@acme.dev')).toBe('approver');
    await remove('approvers', 'approver@acme.dev');
    expect(await roleOf('approver@acme.dev')).toBe('team');
  });

  it('8: the row stays when the deployed config no longer lists the entry', async () => {
    await remove('readers', 'ana@partner.example');
    const deployed = {
      ...LIVE,
      sites: (LIVE.sites as Record<string, unknown>[]).map((s) =>
        s.repo === 'sidecar' ? { ...s, readers: ['@initech.example'] } : s,
      ),
    };
    expect(await status('ana@partner.example', envFor(deployed))).toBe(403);
    expect(await status('ana@partner.example')).toBe(403);
    expect(await pendingRows()).toHaveLength(1);
  });

  it('9: adding the entry back clears the row at once', async () => {
    await remove('readers', 'ana@partner.example');
    await add('readers', 'ana@partner.example');
    expect(await pendingRows()).toEqual([]);
    expect(await status('ana@partner.example')).toBe(200);
  });

  it('17: removing an exact reader still covered by a domain says so', async () => {
    file = {
      sha: 'sha0',
      text: configText({
        ...orgFile,
        sites: LIVE.sites.map((s) =>
          s.repo === 'sidecar' ? { ...s, readers: ['@partner.example', 'ana@partner.example'] } : s,
        ),
      }),
    };
    const r = await remove('readers', 'ana@partner.example');
    expect(html(r)).toContain('They still read through @partner.example.');
  });

  it('13: the root index stops listing the site for a removed reader', async () => {
    const listed = async () => html(await call('/', { raw: true, email: 'ana@partner.example', envOverride: env }));
    expect(await listed()).toContain('href="/sidecar/"');
    await remove('readers', 'ana@partner.example');
    expect(await listed()).not.toContain('href="/sidecar/"');
  });
});

describe('10, 11 and 18: removals stand when the commit does not simply go through', () => {
  it.each([
    ['an unanswered commit that landed', 'lost' as const],
    ['an unanswered commit that did not land', 'refused-lost' as const],
    ['a refused commit (500)', 500],
    ['a refused commit (422)', 422],
  ])('10: %s: the removal stands, and the page says the config may not have changed', async (_n, what) => {
    next = [what];
    const r = await remove('readers', 'ana@partner.example');
    expect(r.status).toBe(502);
    expect(html(r)).toContain('Removed here, not committed');
    expect(await pendingRows()).toHaveLength(1);
    expect(await status('ana@partner.example')).toBe(403);
    if (what === 422) expect(html(r)).toContain('the default branch may be protected');
  });

  it('10: a refused add changes nothing', async () => {
    next = [500];
    const r = await add('readers', 'new@partner.example');
    expect(r.status).toBe(502);
    expect(siteIn('sidecar').readers).not.toContain('new@partner.example');
  });

  it('11 and 18: a file changed meanwhile is retried once on the fresh file; twice, a removal still stands', async () => {
    let raced = false;
    github.repoApi = async (req, repo, path) => {
      if (!raced && req.method === 'PUT') {
        raced = true;
        const c = fileConfig();
        file = {
          sha: 'theirs',
          text: configText({
            ...c,
            sites: c.sites.map((s) => (s.repo === 'web' ? { ...s, readers: ['@other.example'] } : s)),
          }),
        };
      }
      return standIn(req, repo, path);
    };
    expect((await add('readers', 'new@partner.example')).status).toBe(200);
    expect(fileConfig().sites.find((s) => s.repo === 'web')!.readers).toEqual(['@other.example']);
    expect(siteIn('sidecar').readers).toContain('new@partner.example');
    next = [409, 409];
    github.repoApi = standIn;
    const r = await remove('readers', 'ana@partner.example');
    expect(r.status).toBe(502);
    expect(html(r)).toContain('kept changing');
    expect(await pendingRows()).toHaveLength(1);
  });

  it('the removal is recorded before the commit is sent', async () => {
    let rowsAtCommit = -1;
    github.repoApi = async (req, repo, path) => {
      if (req.method === 'PUT') rowsAtCommit = (await pendingRows()).length;
      return standIn(req, repo, path);
    };
    await remove('readers', 'ana@partner.example');
    expect(rowsAtCommit).toBe(1);
  });
});

describe('review fixes: only an admin clears a removal', () => {
  it('an entry added back outside the page is let back in by "add" or "Let back in"', async () => {
    await remove('readers', 'ana@partner.example');
    // Someone re-adds them by a pull request to the config repo.
    const c = fileConfig();
    file = {
      sha: 'pr',
      text: configText({
        ...c,
        sites: c.sites.map((s) =>
          s.repo === 'sidecar' ? { ...s, readers: [...(s.readers as string[]), 'ana@partner.example'] } : s,
        ),
      }),
    };
    // The removal is older than any commit takes to land.
    await workerEnv.DB.prepare('UPDATE pending_removals SET removed_at = removed_at - 180000').run();
    const page = html(await call('/_admin/', { raw: true, email: ADMIN, envOverride: env }));
    expect(page).toMatch(/ana@partner\.example<\/span><span class="meta">refused here by an earlier removal/);
    expect(page).toContain('Let back in');
    const r = await add('readers', 'ana@partner.example');
    expect(html(r)).toContain('already listed; the hub lets them in');
    expect(await pendingRows()).toEqual([]);
    expect(await status('ana@partner.example')).toBe(200);
  });

  it("an add that finds the entry listed does not undo another admin's removal still in flight", async () => {
    await remove('readers', 'ana@partner.example');
    const c = fileConfig();
    file = {
      sha: 'lag',
      text: configText({
        ...c,
        sites: c.sites.map((s) =>
          s.repo === 'sidecar' ? { ...s, readers: [...(s.readers as string[]), 'ana@partner.example'] } : s,
        ),
      }),
    };
    await add('readers', 'ana@partner.example');
    expect(await pendingRows()).toHaveLength(1);
    expect(await status('ana@partner.example')).toBe(403);
  });

  it('a committed removal offers Add back, which commits', async () => {
    await remove('readers', 'ana@partner.example');
    const page = html(await call('/_admin/', { raw: true, email: ADMIN, envOverride: env }));
    expect(page).toMatch(
      /ana@partner\.example<\/span><span class="meta">removed, deploy pending<\/span><\/span><span><form class="inline" method="post" action="\/_admin\/access"><input type="hidden" name="site" value="sidecar"><input type="hidden" name="list" value="readers"><input type="hidden" name="action" value="add">/,
    );
    expect(page).toContain('Add back');
  });

  it('"Let back in" clears a removal and writes nothing', async () => {
    next = [500];
    await remove('readers', 'ana@partner.example');
    const r = await change({ site: 'sidecar', list: 'readers', action: 'restore', entry: 'ana@partner.example' });
    expect(r.status).toBe(200);
    expect(await pendingRows()).toEqual([]);
    expect(puts).toHaveLength(1);
    expect(await status('ana@partner.example')).toBe(200);
  });

  it('someone already removed in git but not deployed is refused at once', async () => {
    const c = fileConfig();
    file = {
      sha: 'pr',
      text: configText({
        ...c,
        sites: c.sites.map((s) => (s.repo === 'sidecar' ? { ...s, readers: ['@initech.example'] } : s)),
      }),
    };
    const page = html(await call('/_admin/', { raw: true, email: ADMIN, envOverride: env }));
    expect(page).toMatch(/ana@partner\.example<\/span><span class="meta">removed in git, deploy pending/);
    const r = await remove('readers', 'ana@partner.example');
    expect(html(r)).toContain('already removed in git, not yet deployed');
    expect(puts).toEqual([]);
    expect(await status('ana@partner.example')).toBe(403);
  });

  it('an unrelated problem in the config file does not block a removal from counting', async () => {
    const c = fileConfig() as Record<string, unknown>;
    file = { sha: 'bad', text: configText({ ...c, unknownKey: true }) };
    const r = await remove('readers', 'ana@partner.example');
    expect(r.status).toBe(502);
    expect(html(r)).toContain('the config file has other problems, so the commit was not made');
    expect(puts).toEqual([]);
    expect(await status('ana@partner.example')).toBe(403);
  });

  it('without the database, a site path answers 503 to someone the config lets in, and 403 to a stranger', async () => {
    await workerEnv.DB.prepare('ALTER TABLE pending_removals RENAME TO pending_removals_away').run();
    try {
      expect(await status('ana@partner.example')).toBe(503);
      expect(await status('stranger@nowhere.example')).toBe(403);
      // The index fails closed: readers' sites are left out, the team's stay.
      const reader = html(await call('/', { raw: true, email: 'ana@partner.example', envOverride: env }));
      expect(reader).not.toContain('href="/sidecar/"');
      const team = html(await call('/', { raw: true, email: 'dev@acme.dev', envOverride: env }));
      expect(team).toContain('href="/sidecar/"');
    } finally {
      await workerEnv.DB.prepare('ALTER TABLE pending_removals_away RENAME TO pending_removals').run();
    }
  });
});

describe('14: the page', () => {
  it("shows git's lists with what is live, added or removed pending, remove buttons, add forms and the history", async () => {
    await remove('readers', 'ana@partner.example');
    await add('readers', 'zed@partner.example');
    const p = html(await call('/_admin/', { raw: true, email: ADMIN, envOverride: env }));
    expect(p).toContain('<h2>Who reads and approves</h2>');
    expect(p).toContain('href="https://github.com/acme/docs-hub/commits/main/specreview.config.json"');
    expect(p).toMatch(/zed@partner\.example<\/span><span class="meta">added, deploy pending/);
    expect(p).toMatch(/ana@partner\.example<\/span><span class="meta">removed, deploy pending/);
    expect(p).toMatch(/@initech\.example<\/span><\/span><span><form class="inline"/);
    expect(p).toContain('<input type="hidden" name="entry" value="@initech.example">');
    expect(p).toContain('Add a reader');
    expect(p).toContain('an email at acme.dev');
  });

  it('when the config cannot be read, the lists cannot be changed and say so', async () => {
    reads = 'down';
    const p = html(await call('/_admin/', { raw: true, email: ADMIN, envOverride: env }));
    expect(p).toContain('The hub could not read the config from GitHub');
    expect(p).not.toContain('action="/_admin/access"');
  });
});
