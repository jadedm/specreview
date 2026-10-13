// #28: a failed label sync logs one line per ticket repo naming the step and
// GitHub's answer. Case numbers are the ticket's.
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { memoryStore } from '../src/store';
import {
  comment,
  call,
  deps,
  github,
  installFetch,
  LIVE_HASH,
  PAGE,
  publishedFiles,
  reconcile,
  reset,
  runCron,
  WEB,
} from './helpers';

let fetchSpy: ReturnType<typeof installFetch>;
let errors: MockInstance<typeof console.error>;
beforeEach(async () => {
  fetchSpy = installFetch();
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  await reset();
});
afterEach(() => {
  // 14: no line carries a token or a response body that is not GitHub's JSON message.
  for (const line of lines()) {
    for (const secret of ['test-write', 'test-read', 'boom', 'unavailable']) expect(line).not.toContain(secret);
  }
  errors.mockRestore();
  fetchSpy.mockRestore();
});

const lines = () => errors.mock.calls.map((args) => args.map(String).join(' '));
const lineFor = (repo: string) => {
  const found = lines().filter((l) => l.startsWith(`label sync failed for ${repo}: `));
  expect(found).toHaveLength(1);
  return found[0];
};
const json = (status: number, body: unknown) => Response.json(body, { status });
const setStatus = (email: string, status: string, expectedVersion: number) =>
  call('/api/status', { email, body: { page: PAGE, status, expectedVersion, hash: LIVE_HASH } });

describe('28: the cron says why a ticket repo failed', () => {
  it('1: no write token', async () => {
    await runCron({ GITHUB_WRITE_TOKEN: undefined });
    expect(lineFor('acme/sidecar')).toMatch(/: no GitHub write token for acme\/sidecar( \(and \d+ more\))?$/);
  });

  it('2, 13: a token that cannot see the repo (every call 404)', async () => {
    github.answer = (_m, repo) => (repo === 'acme/sidecar' ? json(404, { message: 'Not Found' }) : null);
    expect((await reconcile())['acme/sidecar']).toBe('failed');
    expect(lineFor('acme/sidecar')).toMatch(
      /: POST \/labels -> 404 Not Found \(the token cannot see the repo\) \(and \d+ more\)$/,
    );
    expect(lines().some((l) => l.startsWith('label sync failed for acme/globex'))).toBe(false);
  });

  it('3: a token GitHub rejects', async () => {
    github.answer = (m, _r, path) =>
      m === 'GET' && path.startsWith('/labels/') ? json(401, { message: 'Bad credentials' }) : null;
    await runCron();
    expect(lineFor('acme/sidecar')).toMatch(
      /: GET \/labels\/docs%3A%20\S+ -> 401 Bad credentials \(the token is invalid or expired\)/,
    );
  });

  it('4: a token without permission, with GitHub message', async () => {
    github.answer = (m, _r, path) =>
      m === 'GET' && path.startsWith('/labels/')
        ? json(403, { message: 'Resource not accessible by personal access token' })
        : null;
    await runCron();
    expect(lineFor('acme/sidecar')).toContain(
      '-> 403 Resource not accessible by personal access token (the token lacks permission or hit a rate limit)',
    );
  });

  it('5: a label create refused as invalid', async () => {
    github.labelsMode = 'invalid';
    await runCron();
    expect(lineFor('acme/sidecar')).toMatch(/: POST \/labels -> 422 \(GitHub refused the request\)/);
  });

  it('6: a ticket that cannot be read', async () => {
    github.answer = (m, _r, path) =>
      m === 'GET' && path === '/issues/52' ? new Response('boom', { status: 500 }) : null;
    await runCron();
    expect(lineFor('acme/sidecar')).toMatch(/: GET \/issues\/52 -> 500 \(GitHub had an error\)$/);
  });

  it('7: adding the wanted label fails', async () => {
    github.answer = (m, _r, path) =>
      m === 'POST' && path === '/issues/52/labels' ? new Response('boom', { status: 500 }) : null;
    await runCron();
    expect(lineFor('acme/sidecar')).toMatch(/: POST \/issues\/52\/labels -> 500 \(GitHub had an error\)$/);
  });

  it('8: removing an old label fails', async () => {
    github.issues.get(52)!.labels = ['docs: in review'];
    github.answer = (m, _r, path) =>
      m === 'DELETE' && path.startsWith('/issues/52/labels/') ? new Response('boom', { status: 500 }) : null;
    await runCron();
    expect(lineFor('acme/sidecar')).toMatch(
      /: DELETE \/issues\/52\/labels\/docs%3A%20in%20review -> 500 \(GitHub had an error\)$/,
    );
  });

  it('9: listing the labelled tickets fails', async () => {
    github.answer = (m, _r, path) =>
      m === 'GET' && path.startsWith('/issues?') ? new Response('unavailable', { status: 503 }) : null;
    await runCron();
    expect(lineFor('acme/sidecar')).toMatch(
      /: GET \/issues\?state=all&per_page=100&page=1&labels=docs%3A%20\S+ -> 503 \(GitHub had an error\)/,
    );
  });

  it('10: a request with no answer', async () => {
    github.answer = (_m, _r, path) => {
      if (path === '/issues/23') throw new TypeError('network connection lost');
      return null;
    };
    await runCron();
    expect(lineFor('acme/sidecar')).toMatch(/: GET \/issues\/23 -> no response \(TypeError\)$/);
  });

  it('11: a site sharing the ticket repo whose published version is broken', async () => {
    const files = publishedFiles();
    files.set(`${WEB}/current.json`, 'not json');
    deps.store = memoryStore(files);
    await runCron();
    expect(lineFor('acme/sidecar')).toMatch(/: site acme\/web: its published version cannot be read \(SITE_BROKEN\)$/);
  });

  it('12: each failing ticket repo gets its own line', async () => {
    github.down = true;
    await runCron();
    expect(lineFor('acme/sidecar')).toContain('-> 503');
    expect(lineFor('acme/globex')).toContain('-> 503');
    expect(lines()).toHaveLength(2);
  });

  it('19: a label created by someone else meanwhile is done, not a failure', async () => {
    github.labelDefs.set('acme/sidecar', new Set(['docs: pending', 'docs: in review', 'docs: ready to build']));
    github.answer = (m, repo, path) =>
      m === 'GET' && repo === 'acme/sidecar' && path.startsWith('/labels/')
        ? json(404, { message: 'Not Found' })
        : null;
    expect((await reconcile())['acme/sidecar']).toBe('updated');
    expect(github.issues.get(52)!.labels).toContain('docs: pending');
    expect(lines()).toEqual([]);
  });
});

describe('28: after review', () => {
  it("GitHub's message is cut to 200 characters and nothing else in the body is logged", async () => {
    github.answer = (m, _r, path) =>
      m === 'GET' && path === '/issues/52'
        ? json(500, { message: `${'m'.repeat(300)}`, internal: 'not-for-logs', documentation_url: 'https://x' })
        : null;
    await runCron();
    const line = lineFor('acme/sidecar');
    expect(line).toContain(`GET /issues/52 -> 500 ${'m'.repeat(200)} (GitHub had an error)`);
    expect(line).not.toContain('m'.repeat(201));
    expect(line).not.toContain('not-for-logs');
    expect(line).not.toContain('https://x');
  });

  it('an error thrown inside a page sync is logged; the status change still answers', async () => {
    // A ticket whose labels are not a list makes the sync throw past every
    // step's own handling.
    github.answer = (m, _r, path) =>
      m === 'GET' && path === '/issues/23' ? json(200, { number: 23, labels: 'x' }) : null;
    const r = await setStatus('dev@acme.dev', 'in_review', 0);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ labels: 'failed' });
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatch(/: unexpected error \(TypeError: .+\)/);
  });
});

describe('28: a page change says why its sync failed', () => {
  it('15: a status change answers as before and logs the reason', async () => {
    github.down = true;
    const r = await setStatus('dev@acme.dev', 'in_review', 0);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ labels: 'failed' });
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatch(
      new RegExp(
        `^label sync failed for acme/sidecar after a change to acme/sidecar ${PAGE}: .+ -> 503 \\(GitHub had an error\\)`,
      ),
    );
  });

  it('16: a comment that moves a ready page back logs the reason', async () => {
    await setStatus('approver@acme.dev', 'ready', 0);
    github.down = true;
    expect((await comment('riya@initech.example')).status).toBe(201);
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatch(/^label sync failed for acme\/sidecar after a change to acme\/sidecar .+ -> 503/);
  });

  it('17: syncs that succeed log nothing', async () => {
    await setStatus('dev@acme.dev', 'in_review', 0);
    await runCron();
    expect(github.issues.get(23)!.labels).toContain('docs: in review');
    expect(lines()).toEqual([]);
  });
});
