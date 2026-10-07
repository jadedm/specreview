import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { call, comment, errorCode, HOST, installFetch, reset, COMMIT_OLD } from './helpers';

let spy: ReturnType<typeof installFetch>;
beforeEach(async () => {
  spy = installFetch();
  await reset();
});
afterEach(() => spy.mockRestore());

const READER = 'riya@ariai.example';
const TEAM = 'dev@inoltro.ai';

describe('46: state-changing requests', () => {
  it('must be JSON', async () => {
    const r = await comment(READER, {});
    expect(r.status).toBe(201);
    const text = await call('/api/comments', {
      email: READER,
      rawBody: '{}',
      headers: { 'content-type': 'text/plain' },
    });
    expect(text.status).toBe(415);
  });

  it('must come from our own origin', async () => {
    for (const origin of ['https://evil.example', 'null', `${HOST}.evil.example`]) {
      const r = await call('/api/comments', { email: READER, body: {}, headers: { origin } });
      expect(r.status, origin).toBe(403);
      expect(errorCode(r)).toBe('BAD_ORIGIN');
    }
  });

  it('cannot be done with GET; unknown paths are 404', async () => {
    expect((await call('/api/status', { email: TEAM, method: 'PUT', rawBody: '{}' })).status).toBe(405);
    expect((await call('/api/me', { email: TEAM, method: 'POST', body: {} })).status).toBe(405);
    expect((await call(`/api/comments/${crypto.randomUUID()}/resolve`, { email: TEAM })).status).toBe(405);
    expect((await call('/api/nothing', { email: TEAM })).status).toBe(404);
    expect((await call('/api', { email: TEAM })).status).toBe(404);
  });

  it('a body over 20 KB is refused, declared or streamed', async () => {
    const big = JSON.stringify({ body: 'x'.repeat(21_000) });
    expect((await call('/api/comments', { email: READER, rawBody: big })).status).toBe(413);
    const declared = await call('/api/comments', {
      email: READER,
      rawBody: '{}',
      headers: { 'content-length': '999999' },
    });
    expect(declared.status).toBe(413);
  });
});

describe('48: old versions', () => {
  it('only the Inoltro team can read them', async () => {
    const path = `/_history/${COMMIT_OLD}/onboarding/signup.md`;
    expect((await call(path)).status).toBe(401);
    expect((await call(path, { email: READER })).status).toBe(403);
    const ok = await call(path, { email: TEAM });
    expect(ok.status).toBe(200);
    expect(String(ok.body)).toContain('Anyone with the join link can join.');
    expect(ok.headers.get('cache-control')).toBe('no-store');
  });
});

describe('49, 50: responses and shadowing', () => {
  it('API responses, including refusals, are no-store', async () => {
    for (const r of [
      await call('/api/me'),
      await call('/api/me', { email: READER }),
      await call('/api/x', { email: READER }),
    ]) {
      expect(r.headers.get('cache-control')).toBe('no-store');
    }
  });

  // The hub has no static assets: every path goes through the Worker.
  it('the Worker answers /api/comments/ itself, refusing it without a token', async () => {
    const r = await call('/api/comments/');
    expect(r.status).toBe(401);
    expect(String(r.body)).not.toContain('must never answer');
  });

  it('pages are not served yet (#4); / is 404', async () => {
    expect((await call('/inoltrotech/sidecar/onboarding/signup')).status).toBe(404);
    expect((await call('/')).status).toBe(404);
  });
});
