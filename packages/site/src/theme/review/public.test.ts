// @vitest-environment happy-dom
// #20: on a public site's page the panel shows nothing to a visitor the hub
// does not know. Case numbers are the ticket's.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFor } from './api';
import { BOTTOM_MOUNT, createReview, SIGNED_OUT_TEXT, TOP_MOUNT } from './start';

const team = { email: 'dev@x.example', role: 'team' };
const PAGES = {
  commit: 'c',
  pages: { a: { title: 'A', hash: 'h', issues: [], sections: [{ id: 'limits', title: 'Limits', text: 'x' }] } },
};
const STATUS = [
  {
    page: 'a',
    title: 'A',
    hash: 'h',
    status: 'pending',
    version: 0,
    changedBy: null,
    changedAt: null,
    wasReadyAt: null,
  },
];
const accessRedirect = () => ({ type: 'opaqueredirect', status: 0, ok: false, headers: new Headers() }) as Response;

const hub = (me: () => Response) => async (url: string) => {
  if (url.endsWith('_api/me')) return me();
  if (url.endsWith('_api/pages')) return Response.json(PAGES);
  if (url.endsWith('_api/status')) return Response.json(STATUS);
  return Response.json([]);
};
const stub = (route: (url: string) => Promise<Response>) => vi.stubGlobal('fetch', vi.fn(route));
const markPublic = () => {
  const meta = document.createElement('meta');
  meta.setAttribute('name', 'specreview-visibility');
  meta.setAttribute('content', 'public');
  document.head.append(meta);
};
const mounts = () => [TOP_MOUNT, BOTTOM_MOUNT].map((id) => document.getElementById(id)!);
const shown = () =>
  mounts()
    .map((m) => m.textContent ?? '')
    .join('');

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = `<div class="vp-doc"><div><h2 id="limits">Limits</h2><p>Text</p></div></div><div id="${TOP_MOUNT}"></div><div id="${BOTTOM_MOUNT}"></div>`;
});
afterEach(() => vi.unstubAllGlobals());

describe('20: the panel on a public page', () => {
  it('11: a visitor the hub does not know sees nothing: no placeholders, no notice', async () => {
    markPublic();
    for (const me of [
      accessRedirect,
      () => new Response(null, { status: 401 }),
      () => Promise.reject(new TypeError('Failed to fetch')) as never,
    ]) {
      stub(hub(me));
      const review = createReview(apiFor('/s/'), '/s/');
      const pending = review.render('a');
      // Nothing while `me` is asked, either.
      expect(document.querySelector('.rv-skel-bar')).toBeNull();
      await pending;
      expect(shown()).toBe('');
      expect(document.querySelector('[role="alert"]')).toBeNull();
    }
  });

  it('12: a signed-in visitor gets the panel as on a private site', async () => {
    markPublic();
    stub(hub(() => Response.json(team)));
    await createReview(apiFor('/s/'), '/s/').render('a');
    expect(document.querySelector('.rv-status')).not.toBeNull();
  });

  it('review: a sign-in that lapses mid-visit on a public page is silence, and the next page asks again', async () => {
    markPublic();
    let signedIn = true;
    const meCalls: number[] = [];
    stub(async (url: string) => {
      if (url.endsWith('_api/me')) meCalls.push(1);
      if (!signedIn && url.includes('_api/')) return accessRedirect();
      return hub(() => Response.json(team))(url);
    });
    const review = createReview(apiFor('/s/'), '/s/');
    await review.render('a');
    expect(document.querySelector('.rv-status')).not.toBeNull();
    signedIn = false;
    await review.render('a');
    expect(shown()).toBe('');
    expect(document.querySelector('[role="alert"]')).toBeNull();
    await review.render('a');
    expect(meCalls.length).toBe(2);
  });

  it('13: on a private page an expired sign-in still says so', async () => {
    stub(hub(accessRedirect));
    await createReview(apiFor('/s/'), '/s/').render('a');
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(SIGNED_OUT_TEXT);
  });
});
