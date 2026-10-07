// The Worker as deployed: the default export, with the store not wired yet (#4).
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it } from 'vitest';
import worker from '../src/index';
import { HOST, installFetch, reset, testEnv, tokenFor } from './helpers';

let spy: ReturnType<typeof installFetch>;
beforeEach(async () => {
  spy = installFetch();
  await reset();
});
afterEach(() => spy.mockRestore());

const send = async (path: string, headers: Record<string, string> = {}) => {
  const ctx = createExecutionContext();
  const req = new Request(`${HOST}${path}`, { headers }) as Request<unknown, IncomingRequestCfProperties>;
  const res = await worker.fetch(req, testEnv(), ctx);
  await waitOnExecutionContext(ctx);
  return res;
};

it('/ is 404 with no-store', async () => {
  const res = await send('/');
  expect(res.status).toBe(404);
  expect(res.headers.get('cache-control')).toBe('no-store');
});

it('a site API that needs pages answers STORE_NOT_CONFIGURED until #4', async () => {
  const res = await send('/inoltrotech/sidecar/_api/status', {
    'cf-access-jwt-assertion': await tokenFor('dev@inoltro.ai'),
  });
  expect(res.status).toBe(500);
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe('STORE_NOT_CONFIGURED');
});
