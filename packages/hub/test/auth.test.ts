import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { call, errorCode, installFetch, reset, strangerKey, token } from './helpers';

let spy: ReturnType<typeof installFetch>;
beforeEach(async () => {
  spy = installFetch();
  await reset();
});
afterEach(() => spy.mockRestore());

describe('Access token', () => {
  it('1: no token is refused and nothing is read', async () => {
    const r = await call('/api/me');
    expect(r.status).toBe(401);
    expect(errorCode(r)).toBe('UNAUTHORIZED');
  });

  it('4: a valid token runs as the email inside it', async () => {
    const r = await call('/api/me', { email: 'Riya@Ariai.Example' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ email: 'riya@ariai.example', role: 'reader' });
  });
});

describe('Access token edges', () => {
  it('2: unknown signing key, wrong audience, wrong issuer, expired', async () => {
    const bad = [
      await token({ email: 'a@inoltro.ai', key: strangerKey.privateKey }),
      await token({ email: 'a@inoltro.ai', aud: 'another-app' }),
      await token({ email: 'a@inoltro.ai', iss: 'https://evil.cloudflareaccess.com' }),
      await token({ email: 'a@inoltro.ai', expiresIn: '-1m' }),
    ];
    for (const t of bad) expect((await call('/api/me', { token: t })).status).toBe(401);
  });

  it('3: an email header without a token is ignored', async () => {
    const r = await call('/api/me', { headers: { 'cf-access-authenticated-user-email': 'boss@inoltro.ai' } });
    expect(r.status).toBe(401);
  });

  it('33: malformed token, other algorithm, future nbf, no email, email not a string', async () => {
    const hs = await new (await import('jose')).SignJWT({ email: 'a@inoltro.ai' })
      .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
      .setIssuer('https://test.cloudflareaccess.com')
      .setAudience('aud-docs')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('a-shared-secret-of-enough-length-1234'));
    const bad = [
      'not.a.jwt',
      hs,
      await token({ email: 'a@inoltro.ai', notBefore: '10m' }),
      await token({}),
      await token({ email: 42 }),
      await token({ email: ['a@inoltro.ai'] }),
    ];
    for (const t of bad) expect((await call('/api/me', { token: t })).status).toBe(401);
  });

  it('34: a token whose kid is not in the key set', async () => {
    const t = await token({ email: 'a@inoltro.ai', kid: 'k2', key: strangerKey.privateKey });
    expect((await call('/api/me', { token: t })).status).toBe(401);
  });

  it('refuses everything when the hub has no config', async () => {
    const r = await call('/api/me', { email: 'a@inoltro.ai', envOverride: { SPECREVIEW_CONFIG: '' } });
    expect(r.status).toBe(500);
    expect(errorCode(r)).toBe('CONFIG_INVALID');
  });
});

it('35: an uppercase Inoltro address is team', async () => {
  const r = await call('/api/me', { email: 'X@INOLTRO.AI' });
  expect(r.body).toEqual({ email: 'x@inoltro.ai', role: 'team' });
});
