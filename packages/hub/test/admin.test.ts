import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetStoredAuth } from '../src/github-auth';
import { saveApp } from '../src/stored-app';
import { appStub, call, github, HOST, installFetch, OWNER_ID, PAGE, reset } from './helpers';

// The admin page (#56): creating the organisation's GitHub App from the hub.
const ADMIN = 'owner@acme.dev';
const HUB_KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const OTHER_KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const APP_ID = 777;
const keys = (await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true,
  ['sign', 'verify'],
)) as CryptoKeyPair;
const pkcs8 = new Uint8Array((await crypto.subtle.exportKey('pkcs8', keys.privateKey)) as ArrayBuffer);
const PEM = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs8))
  .match(/.{1,64}/g)!
  .join('\n')}\n-----END PRIVATE KEY-----\n`;
const PEM_BODY = PEM.split('\n')[1];

let spy: ReturnType<typeof installFetch>;
beforeEach(async () => {
  spy = installFetch();
  await reset();
});
afterEach(() => {
  spy.mockRestore();
  vi.restoreAllMocks();
});

const keyed = { SPECREVIEW_KEY: HUB_KEY };
const admin = (path: string, opts: Parameters<typeof call>[1] = {}) =>
  call(path, { raw: true, email: ADMIN, envOverride: keyed, ...opts });
const html = (r: { body: unknown }) => r.body as unknown as string;
const states = async () =>
  (
    await env.DB.prepare('SELECT state, email, expires_at FROM admin_states ORDER BY expires_at').all<{
      state: string;
      email: string;
      expires_at: number;
    }>()
  ).results;
const storedRow = () => env.DB.prepare('SELECT * FROM github_app').first<Record<string, unknown>>();

const conversion = (owner: Record<string, unknown> = { id: Number(OWNER_ID), type: 'Organization', login: 'acme' }) =>
  Response.json(
    { id: APP_ID, slug: 'specreview-acme', pem: PEM, owner, html_url: 'https://github.com/apps/specreview-acme' },
    { status: 201 },
  );

// Starts the flow as the admin and returns the state the page put in the form.
const startFlow = async () => {
  const r = await admin('/_admin/');
  const state = /settings\/apps\/new\?state=([0-9a-f]{64})/.exec(html(r))?.[1];
  if (!state) throw new Error('no state in the page');
  return state;
};
const finish = (state: string, code = 'code123', email = ADMIN) =>
  admin(`/_admin/github/created?code=${code}&state=${state}`, { email });

describe('1, 2 and 16: who and what reaches the admin page', () => {
  it.each(['dev@acme.dev', 'approver@acme.dev', 'riya@initech.example', 'stranger@nowhere.example'])(
    '%s is refused, and nothing is written',
    async (email) => {
      for (const path of ['/_admin/', `/_admin/github/created?code=c&state=${'a'.repeat(64)}`]) {
        expect((await admin(path, { email })).status).toBe(403);
      }
      expect((await admin('/_admin/github/forget', { email, method: 'POST', headers: { origin: HOST } })).status).toBe(
        403,
      );
      expect(await states()).toEqual([]);
    },
  );

  it('no sign-in is 401; a bad token is 401', async () => {
    expect((await call('/_admin/', { raw: true })).status).toBe(401);
    expect((await call('/_admin/', { raw: true, token: 'not-a-jwt' })).status).toBe(401);
  });

  it('16: wrong methods are 405; /_admin and unknown paths are 404 before any sign-in', async () => {
    expect((await admin('/_admin/', { method: 'POST', headers: { origin: HOST } })).status).toBe(405);
    expect((await admin('/_admin/github/forget')).status).toBe(405);
    for (const path of ['/_admin', '/_admin/x', '/_admin/github/']) {
      expect((await call(path, { raw: true })).status).toBe(404);
    }
  });
});

describe('3 and 14: no app yet', () => {
  it('3: the page posts the manifest to the org on GitHub with a state; the CSP allows only that target', async () => {
    const r = await admin('/_admin/');
    expect(r.status).toBe(200);
    const page = html(r);
    expect(page).toMatch(
      /<form method="post" action="https:\/\/github.com\/organizations\/acme\/settings\/apps\/new\?state=[0-9a-f]{64}">/,
    );
    const manifest = JSON.parse(
      /name="manifest" value="([^"]+)"/
        .exec(page)![1]
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&'),
    ) as Record<string, unknown>;
    expect(manifest).toEqual({
      name: 'specreview acme',
      url: HOST,
      hook_attributes: { url: HOST, active: false },
      redirect_url: `${HOST}/_admin/github/created`,
      public: false,
      default_permissions: { issues: 'write', metadata: 'read' },
      default_events: [],
    });
    expect(r.headers.get('content-security-policy')).toMatch(/form-action 'self' https:\/\/github.com$/);
    expect(r.headers.get('content-security-policy')).toMatch(/^default-src 'none'/);
    expect(page).not.toContain('<script');
    const [row] = await states();
    expect(row.email).toBe(ADMIN);
    expect(row.expires_at - Date.now()).toBeGreaterThan(59 * 60_000);
  });

  it('3: without the hub key the page says to deploy first and offers no form', async () => {
    const r = await admin('/_admin/', { envOverride: {} });
    expect(html(r)).toContain('The hub key is not set yet');
    expect(html(r)).not.toContain('<form');
  });

  it('14: an eleventh live state replaces the oldest', async () => {
    const made: string[] = [];
    for (let i = 0; i < 11; i++) made.push(await startFlow());
    const live = (await states()).map((s) => s.state);
    expect(live).toHaveLength(10);
    expect(live).not.toContain(made[0]);
    expect(live).toContain(made[10]);
  });
});

describe('5 to 10: GitHub sends the admin back', () => {
  it('5: a valid return stores the app with its key sealed, spends the state, and goes back to the page', async () => {
    github.conversion = () => conversion();
    const state = await startFlow();
    const r = await finish(state);
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('/_admin/');
    expect(github.conversions).toEqual(['code123']);
    const row = await storedRow();
    expect(row).toMatchObject({ app_id: APP_ID, slug: 'specreview-acme', created_by: ADMIN });
    expect(JSON.stringify(row)).not.toContain(PEM_BODY.slice(0, 24));
    expect(JSON.stringify(row)).not.toContain('PRIVATE KEY');
    expect(await states()).toEqual([]);
  });

  it.each([
    ['an unknown state', async () => 'b'.repeat(64)],
    [
      'an expired state',
      async () => {
        const s = await startFlow();
        await env.DB.prepare('UPDATE admin_states SET expires_at = 1').run();
        return s;
      },
    ],
  ])('6: %s is refused and GitHub is never asked', async (_name, make) => {
    github.conversion = () => conversion();
    const r = await finish(await make());
    expect(r.status).toBe(400);
    expect(html(r)).toContain('This link has expired');
    expect(github.conversions).toEqual([]);
    expect(await storedRow()).toBeNull();
  });

  it("6: another admin's state, and a state used twice, are refused", async () => {
    github.conversion = () => conversion();
    const state = await startFlow();
    await env.DB.prepare("UPDATE admin_states SET email = 'other@acme.dev'").run();
    expect((await finish(state)).status).toBe(400);
    await env.DB.prepare('UPDATE admin_states SET email = ?').bind(ADMIN).run();
    github.conversion = () => Response.json({ message: 'boom' }, { status: 500 });
    expect((await finish(state)).status).toBe(502);
    expect((await finish(state)).status).toBe(400);
    expect(github.conversions).toEqual(['code123']);
  });

  it('6: a malformed code or state is refused before anything else', async () => {
    for (const q of ['code=x&state=short', `code=bad%20code&state=${'a'.repeat(64)}`, '']) {
      const r = await admin(`/_admin/github/created?${q}`);
      expect(r.status).toBe(400);
      expect(html(r)).toContain('This link is incomplete');
    }
  });

  it.each([
    ['another account', { id: 99, type: 'Organization', login: 'evil' }],
    ['a user with the same id', { id: Number(OWNER_ID), type: 'User', login: 'acme' }],
  ])('7: an app owned by %s is refused and nothing is stored', async (_name, owner) => {
    github.conversion = () => conversion(owner);
    const r = await finish(await startFlow());
    expect(r.status).toBe(400);
    expect(html(r)).toContain('The app belongs to another account');
    expect(await storedRow()).toBeNull();
  });

  it('8: with an app stored, a second return is refused and nothing is replaced, the state kept', async () => {
    github.conversion = () => conversion();
    const first = await startFlow();
    const second = await startFlow();
    await finish(first);
    await env.DB.prepare('UPDATE github_app SET slug = ?').bind('first').run();
    const r = await finish(second, 'code456');
    expect(r.status).toBe(409);
    expect((await storedRow())!.slug).toBe('first');
    expect(github.conversions).toEqual(['code123']);
    expect((await states()).map((s) => s.state)).toEqual([second]);
  });

  it.each([
    ['an expired code', 404],
    ['GitHub down', 503],
  ])('9: %s: a plain page, nothing stored, the state spent', async (_name, status) => {
    github.conversion = () => Response.json({ message: 'x' }, { status });
    const state = await startFlow();
    const r = await finish(state);
    expect(r.status).toBe(502);
    expect(html(r)).toContain(`GitHub answered ${status}`);
    expect(await storedRow()).toBeNull();
    expect(await states()).toEqual([]);
  });

  it('9a: GitHub hands over the key but the hub cannot keep it: the page links the app to delete it', async () => {
    github.conversion = () => conversion();
    const state = await startFlow();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Only the insert fails: the check for a stored app still reads the table.
    await env.DB.prepare(
      "CREATE TRIGGER refuse_app BEFORE INSERT ON github_app BEGIN SELECT RAISE(ABORT, 'refused'); END",
    ).run();
    try {
      const r = await finish(state);
      expect(r.status).toBe(500);
      expect(html(r)).toContain('https://github.com/organizations/acme/settings/apps/specreview-acme');
      expect(html(r)).toContain('GitHub gives the key only once');
      expect(await storedRow()).toBeNull();
    } finally {
      await env.DB.prepare('DROP TRIGGER refuse_app').run();
    }
  });

  it('9: without the hub key the return keeps its state, so the admin can retry after deploying', async () => {
    github.conversion = () => conversion();
    const state = await startFlow();
    const r = await finish(state, 'code123', ADMIN);
    expect(r.status).toBe(303);
    await env.DB.prepare('DELETE FROM github_app').run();
    const again = await startFlow();
    const noKey = await admin(`/_admin/github/created?code=c2&state=${again}`, { envOverride: {} });
    expect(noKey.status).toBe(500);
    expect((await states()).map((s) => s.state)).toContain(again);
  });
});

describe('4, 11 and 13: an app stored', () => {
  const store = async () => {
    github.conversion = () => conversion();
    await finish(await startFlow());
    forgetStoredAuth();
  };

  it('4: the page names the app, who created it, the install link, and each ticket repo', async () => {
    await store();
    github.app = appStub(String(APP_ID), keys.publicKey);
    github.app.installations.delete('acme/globex');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const page = html(await admin('/_admin/'));
    expect(page).toContain('<strong>specreview-acme</strong>, created by owner@acme.dev on');
    expect(page).toContain('href="https://github.com/apps/specreview-acme/installations/new"');
    expect(page).toMatch(/acme\/sidecar<\/span><span class="meta">installed</);
    expect(page).toMatch(/acme\/globex<\/span><span class="meta">not installed</);
    expect(page).toContain('Forget this app');
  });

  it('11: tickets are read with tokens from the stored app; the personal tokens are not sent', async () => {
    await store();
    github.app = appStub(String(APP_ID), keys.publicKey);
    const r = await call(`/api/tickets?page=${encodeURIComponent(PAGE)}`, {
      email: 'dev@acme.dev',
      envOverride: keyed,
    });
    expect((r.body as unknown as { title?: string }[]).map((t) => t.title)).toEqual(['Company approval', 'Join links']);
    expect(github.app.mints).toHaveLength(1);
  });

  it('12: the GITHUB_APP_* secrets win over the stored app; the page says so and offers no form', async () => {
    await store();
    const page = html(
      await admin('/_admin/', { envOverride: { ...keyed, GITHUB_APP_ID: '5', GITHUB_APP_PRIVATE_KEY: PEM } }),
    );
    expect(page).toContain('set in its Worker secrets');
    expect(page).not.toContain('settings/apps/new');
  });

  it('13: a hub key that no longer opens it: no token at all, the page offers to forget it', async () => {
    await store();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const other = { SPECREVIEW_KEY: OTHER_KEY };
    const r = await call(`/api/tickets?page=${encodeURIComponent(PAGE)}`, {
      email: 'dev@acme.dev',
      envOverride: other,
    });
    expect(r.body).toEqual([
      { number: 52, unavailable: true },
      { number: 23, unavailable: true },
    ]);
    expect(github.calls.filter((c) => c.includes('/issues/'))).toEqual([]);
    expect(errors.mock.calls.map((c) => c.join(' ')).join('\n')).toMatch(/stored app specreview-acme cannot be opened/);
    const page = html(await admin('/_admin/', { envOverride: other }));
    expect(page).toContain("this hub's key no longer opens it");
    expect(page).toContain('Forget this app');
  });
});

describe('18: forget', () => {
  it('deletes the app on a same-origin post; another origin or none is refused', async () => {
    github.conversion = () => conversion();
    await finish(await startFlow());
    const refused: Record<string, string>[] = [{ origin: 'https://evil.example' }, {}];
    for (const headers of refused) {
      expect((await admin('/_admin/github/forget', { method: 'POST', headers })).status).toBe(403);
    }
    expect(await storedRow()).not.toBeNull();
    const r = await admin('/_admin/github/forget', { method: 'POST', headers: { origin: HOST } });
    expect(r.status).toBe(303);
    expect(await storedRow()).toBeNull();
    expect(html(await admin('/_admin/'))).toContain('settings/apps/new');
  });

  it('after forgetting, tickets go back to the personal tokens', async () => {
    github.conversion = () => conversion();
    await finish(await startFlow());
    await admin('/_admin/github/forget', { method: 'POST', headers: { origin: HOST } });
    const r = await call(`/api/tickets?page=${encodeURIComponent(PAGE)}`, {
      email: 'dev@acme.dev',
      envOverride: keyed,
    });
    expect((r.body as unknown as { title?: string }[]).map((t) => t.title)).toEqual(['Company approval', 'Join links']);
    expect(github.calls.filter((c) => c.endsWith('/installation') || c.includes('/access_tokens'))).toEqual([]);
  });
});

describe('8: the database keeps one app', () => {
  it('a second save is refused by the table itself, and the first app is kept', async () => {
    const app = { appId: 1, slug: 'first', privateKey: PEM, createdBy: ADMIN, createdAt: 1 };
    const e = { ...env, SPECREVIEW_KEY: HUB_KEY };
    expect(await saveApp(e, app)).toBe(true);
    expect(await saveApp(e, { ...app, appId: 2, slug: 'second' })).toBe(false);
    expect(await storedRow()).toMatchObject({ app_id: 1, slug: 'first' });
  });
});
