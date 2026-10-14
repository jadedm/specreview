import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_AUD, ADMIN_HOST, call, CONFIG, HOST, HUB_AUD, installFetch, reset, token } from './helpers';

// The admin page on its own hostname (#75): served there and only there,
// with its own Access audience; the docs hostname points at it.
const ADMIN = 'owner@acme.dev';
const noAdmin = (() => {
  const { hostname: _h, adminHostname: _a, accessAdminAud: _d, ...rest } = CONFIG;
  return { SPECREVIEW_CONFIG: JSON.stringify(rest) };
})();

let spy: ReturnType<typeof installFetch>;
beforeEach(async () => {
  spy = installFetch();
  await reset();
});
afterEach(() => spy.mockRestore());

describe('#75 the admin hostname', () => {
  it('1: serves the admin page to an admin signed in to it', async () => {
    const r = await call('/_admin/', { raw: true, email: ADMIN });
    expect(r.status).toBe(200);
    expect(String(r.body)).toContain('<h1>GitHub App</h1>');
  });

  it("2: each hostname takes only its own application's sign-in", async () => {
    const docsToken = await token({ email: ADMIN, aud: HUB_AUD });
    expect((await call('/_admin/', { raw: true, token: docsToken })).status).toBe(401);
    const adminToken = await token({ email: 'dev@acme.dev', aud: ADMIN_AUD });
    expect((await call('/api/me', { token: adminToken })).status).toBe(401);
  });

  it('3: someone signed in who is not an admin gets the 403 page', async () => {
    const r = await call('/_admin/', { raw: true, email: 'dev@acme.dev' });
    expect(r.status).toBe(403);
    expect(String(r.body)).toContain('dev@acme.dev');
  });

  it('4: / goes to the admin page; nothing else of the hub is served there, before any sign-in', async () => {
    const root = await call('/', { raw: true, host: 'admin' });
    expect([root.status, root.headers.get('location')]).toEqual([302, '/_admin/']);
    for (const p of ['/sidecar/', '/sidecar/_api/me', '/_publish/sidecar', '/_admin/nope'])
      expect((await call(p, { raw: true, host: 'admin' })).status, p).toBe(404);
    const slash = await call('/_admin', { raw: true, host: 'admin' });
    expect([slash.status, slash.headers.get('location')]).toEqual([308, '/_admin/']);
  });

  it('8: a post carrying the docs hostname as its origin is refused', async () => {
    const r = await call('/_admin/github/forget', {
      raw: true,
      email: ADMIN,
      method: 'POST',
      headers: { origin: HOST },
    });
    expect(r.status).toBe(403);
  });
});

describe('#75 the docs hostname', () => {
  it('5: a GET of an admin path goes to the same path and query on the admin hostname, reading nothing', async () => {
    for (const [from, to] of [
      ['/_admin/', `${ADMIN_HOST}/_admin/`],
      ['/_admin', `${ADMIN_HOST}/_admin/`],
      ['/_admin/github/created?code=abc&state=def', `${ADMIN_HOST}/_admin/github/created?code=abc&state=def`],
    ]) {
      const r = await call(from, { raw: true, host: 'docs' });
      expect([r.status, r.headers.get('location')], from).toEqual([308, to]);
    }
  });

  it('6: posts to admin paths are not here, even from an admin signed in to the docs hostname', async () => {
    for (const p of ['/_admin/access', '/_admin/sites', '/_admin/github/forget']) {
      const r = await call(p, {
        raw: true,
        host: 'docs',
        email: ADMIN,
        method: 'POST',
        rawBody: 'x=1',
        headers: { origin: HOST, 'content-type': 'application/x-www-form-urlencoded' },
      });
      expect(r.status, p).toBe(404);
    }
  });

  it('7: with no admin hostname, the docs hostname says the admin page needs one and serves no admin content', async () => {
    const r = await call('/_admin/', { raw: true, host: 'docs', email: ADMIN, envOverride: noAdmin });
    expect(r.status).toBe(404);
    expect(String(r.body)).toContain('The admin page needs its own hostname');
    expect(String(r.body)).not.toContain('GitHub App</h1>');
    const post = await call('/_admin/github/forget', {
      raw: true,
      host: 'docs',
      email: ADMIN,
      method: 'POST',
      headers: { origin: HOST },
      envOverride: noAdmin,
    });
    expect(post.status).toBe(404);
    expect((await call('/_admin/nope', { raw: true, host: 'docs', envOverride: noAdmin })).status).toBe(404);
  });

  it('the docs sites still work on the docs hostname', async () => {
    expect((await call('/api/me', { email: 'dev@acme.dev' })).status).toBe(200);
  });
});
