// The Worker as deployed: the default export, reading pages from the SITES
// bucket the way a publish (#5) leaves it.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it } from 'vitest';
import worker from '../src/index';
import { HOST, installFetch, manifests, publishedFiles, reset, SIDECAR, testEnv, tokenFor } from './helpers';

let spy: ReturnType<typeof installFetch>;
beforeEach(async () => {
  spy = installFetch();
  await reset();
  for (const [key, text] of publishedFiles(manifests())) await env.SITES?.put(key, text);
});
afterEach(() => spy.mockRestore());

const send = async (path: string, headers: Record<string, string> = {}, override = {}) => {
  const ctx = createExecutionContext();
  const req = new Request(`${HOST}${path}`, { headers }) as Request<unknown, IncomingRequestCfProperties>;
  const res = await worker.fetch(req, testEnv(override), ctx);
  await waitOnExecutionContext(ctx);
  return res;
};

it('/ is 404 with no-store', async () => {
  const res = await send('/');
  expect(res.status).toBe(404);
  expect(res.headers.get('cache-control')).toBe('no-store');
});

it('serves a page and the site API from the SITES bucket', async () => {
  const auth = { 'cf-access-jwt-assertion': await tokenFor('dev@acme.dev') };
  const page = await send(`/${SIDECAR}/onboarding/signup`, auth);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain(`${SIDECAR} signup`);
  expect((await send(`/${SIDECAR}/_api/status`, auth)).status).toBe(200);
});

it('without the bucket bound, a site answers STORE_NOT_CONFIGURED', async () => {
  const res = await send(
    `/${SIDECAR}/_api/status`,
    { 'cf-access-jwt-assertion': await tokenFor('dev@acme.dev') },
    { SITES: undefined },
  );
  expect(res.status).toBe(500);
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe('STORE_NOT_CONFIGURED');
});
