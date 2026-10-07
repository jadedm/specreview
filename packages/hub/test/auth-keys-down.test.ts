import { afterEach, beforeEach, expect, it } from 'vitest';
import { call, certs, installFetch, reset } from './helpers';

// Its own file, so the key set has never been fetched in this isolate.
let spy: ReturnType<typeof installFetch>;
beforeEach(async () => {
  spy = installFetch();
  certs.down = true;
  await reset();
});
afterEach(() => {
  certs.down = false;
  spy.mockRestore();
});

it('34: key set unreachable fails closed', async () => {
  const r = await call('/api/me', { email: 'a@inoltro.ai' });
  expect(r.status).toBe(401);
  expect(certs.served).toBeGreaterThan(0);
});
