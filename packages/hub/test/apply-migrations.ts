import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, expect } from 'vitest';
import { github } from './helpers';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// #77: every GitHub call refuses redirects; the stand-in records any that
// would follow one, in any test.
afterEach(() => {
  const followed = github.followed.splice(0);
  expect(followed, 'GitHub calls that would follow a redirect').toEqual([]);
});
