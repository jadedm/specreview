// #91: team and approvers by domain or by individual email. Someone named in
// `team`, and every approver, has the team's view; an approver anywhere also
// has the team's powers and signs off.
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { addPending } from '../src/pending';
import { call, CONFIG, installFetch, LIVE_HASH, PAGE, reset } from './helpers';

const MEMBER = 'manish@ariai.example';
const OUTSIDE = 'boss@elsewhere.example';
const LEAD = 'kim@leads.example';
const READER = 'riya@initech.example';

const config = structuredClone(CONFIG) as typeof CONFIG & { sites: Record<string, unknown>[] };
config.sites[0] = {
  ...config.sites[0],
  team: [MEMBER],
  approvers: ['approver@acme.dev', OUTSIDE, '@leads.example'],
  readers: ['@initech.example', '@leads.example'],
};
const envOverride = { SPECREVIEW_CONFIG: JSON.stringify(config) } as Partial<Env>;
const as = (email: string, path: string, opts: Record<string, unknown> = {}) =>
  call(path, { email, envOverride, ...opts });
const me = async (email: string, site = 'sidecar') => {
  const r = await call('/api/me', { email, site, envOverride });
  return r.status === 200 ? (r.body as unknown as { role: string }).role : r.status;
};
const post = (email: string, body: Record<string, unknown>) =>
  as(email, '/api/comments', {
    body: { page: PAGE, heading: 'limits', quote: 'including ones waiting for approval', body: 'A question', ...body },
  });
const setStatus = (email: string, status: string, expectedVersion: number) =>
  as(email, '/api/status', { body: { page: PAGE, status, expectedVersion, hash: LIVE_HASH } });

let spy: ReturnType<typeof installFetch>;
beforeEach(async () => {
  spy = installFetch();
  await reset();
});
afterEach(() => spy.mockRestore());

describe('#91: who is team and who approves', () => {
  it('3, 4, 5: a named team member is team; an approver anywhere, by email or @domain, is approver, above reader', async () => {
    expect(await me(MEMBER)).toBe('team');
    expect(await me(OUTSIDE)).toBe('approver');
    expect(await me(LEAD)).toBe('approver');
    expect(await me('someone@elsewhere.example')).toBe(403);
    expect(await me(READER)).toBe('reader');
  });

  it('3: a named team member sees emails; a reader sees them as the team label', async () => {
    const c = await post(READER, {});
    expect(c.status).toBe(201);
    await post(MEMBER, { body: 'From the team' });
    type Thread = { author: string; body: string };
    const list = async (email: string) =>
      ((await as(email, `/api/comments?page=${encodeURIComponent(PAGE)}`)).body as unknown as Thread[]).map(
        (t) => t.author,
      );
    expect((await list(MEMBER)).sort()).toEqual([MEMBER, READER].sort());
    expect(await list(READER)).toEqual(expect.arrayContaining(['You', 'acme team']));
  });

  it("4: an outside approver resolves anyone's thread and signs a page off", async () => {
    const c = await post(READER, {});
    const id = (c.body as unknown as { id: number }).id;
    expect((await as(OUTSIDE, `/api/comments/${id}/resolve`, { body: {} })).status).toBe(200);
    expect((await setStatus(OUTSIDE, 'in_review', 0)).status).toBe(200);
    expect((await setStatus(OUTSIDE, 'ready', 1)).status).toBe(200);
  });

  it('shared ticket repo: an approver of one site is nobody on the other', async () => {
    expect(await me(OUTSIDE, 'web')).toBe(403);
    expect(await me(MEMBER, 'web')).toBe(403);
  });

  it('8: a removal recorded for a named team member or an outside approver takes their access at once', async () => {
    await addPending(env, 'acme/sidecar', 'team', MEMBER, 'owner@acme.dev');
    await addPending(env, 'acme/sidecar', 'approvers', OUTSIDE, 'owner@acme.dev');
    expect(await me(MEMBER)).toBe(403);
    expect(await me(OUTSIDE)).toBe(403);
    // Someone the removal does not name keeps their role.
    expect(await me(LEAD)).toBe('approver');
  });

  it('9: with the database not answering, the index leaves out named team members and outside approvers', async () => {
    const slow = {
      ...envOverride,
      DB: { prepare: () => ({ bind: () => ({ all: () => new Promise(() => {}) }) }) } as unknown as Env['DB'],
    };
    const listed = async (email: string) => String((await call('/', { raw: true, email, envOverride: slow })).body);
    expect(await listed(MEMBER)).not.toContain('/sidecar/');
    expect(await listed(OUTSIDE)).not.toContain('/sidecar/');
    expect(await listed('dev@acme.dev')).toContain('/sidecar/');
  }, 30_000);
});
