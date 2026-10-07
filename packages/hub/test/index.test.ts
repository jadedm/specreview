import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import worker from '../src/index';

it('answers 404 with no-store until the hub exists', async () => {
  const req = new Request('https://docs.example.com/') as Request<unknown, IncomingRequestCfProperties>;
  const res = await worker.fetch(req, env, createExecutionContext());
  expect(res.status).toBe(404);
  expect(res.headers.get('cache-control')).toBe('no-store');
});
