// #77: GitHub calls never follow a redirect; one reads as a failure that
// names the status and nothing of where it pointed.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { API, githubFetch } from '../src/github-fetch';
import { github, installFetch, reset } from './helpers';

let spy: ReturnType<typeof installFetch>;
beforeEach(async () => {
  spy = installFetch();
  await reset();
});
afterEach(() => spy.mockRestore());

const answering = (status: number) => {
  github.answer = () =>
    new Response(status === 304 ? null : 'moved', {
      status,
      headers: { location: 'https://elsewhere.example/repos/x/y' },
    });
};

describe('#77: githubFetch', () => {
  it.each([301, 302, 303, 307, 308])('a %i is a 502 naming the status, and is not followed', async (status) => {
    answering(status);
    const r = await githubFetch(`${API}/repos/acme/sidecar/issues/52`);
    expect(r.status).toBe(502);
    const body = await r.text();
    expect(JSON.parse(body)).toEqual({ message: `GitHub answered with a redirect (${status})` });
    expect(body).not.toContain('elsewhere');
    expect(spy.mock.calls.map(([input]) => String(input instanceof Request ? input.url : input))).toEqual([
      `${API}/repos/acme/sidecar/issues/52`,
    ]);
  });

  it('a 304 and ordinary answers pass through unchanged', async () => {
    answering(304);
    expect((await githubFetch(`${API}/repos/acme/sidecar/issues/52`)).status).toBe(304);
    github.answer = null;
    const r = await githubFetch(`${API}/repos/acme/sidecar/issues/52`);
    expect([r.status, ((await r.json()) as { title: string }).title]).toEqual([200, 'Company approval']);
  });

  it('asks fetch not to follow redirects, whatever the caller passed', async () => {
    await githubFetch(`${API}/repos/acme/sidecar/issues/52`, { redirect: 'follow' });
    const [input, init] = spy.mock.calls[0];
    expect(new Request(input, init).redirect).toBe('manual');
  });
});
