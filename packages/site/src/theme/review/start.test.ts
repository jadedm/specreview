// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Api, apiFor, ApiError, type Me, type Pages } from './api';
import { BOTTOM_MOUNT, createReview, TOP_MOUNT } from './start';

const PAGE = { title: 'Signup', hash: 'h', issues: [52], sections: [{ id: 'limits', title: 'Limits', text: 'x' }] };
const HISTORY = [
  { commit: 'a'.repeat(40), date: '2026-10-07T00:00:00Z', author: 'Dev', pr: 2, path: 'p.md', hash: 'h' },
];
const status = {
  page: 'signup',
  title: 'Signup',
  hash: 'h',
  status: 'pending' as const,
  version: 0,
  changedBy: null,
  changedAt: null,
  wasReadyAt: null,
};

const fakeApi = (me: Me, pages: Pages, over: Partial<Api> = {}): Api =>
  ({
    me: async () => me,
    pages: async () => pages,
    comments: async () => [],
    statuses: async () => [status, { ...status, page: 'index', title: 'Home' }],
    tickets: async () => [],
    ...over,
  }) as Api;

beforeEach(() => {
  document.body.innerHTML = `<div class="vp-doc"><div><p>x</p></div></div><div id="${TOP_MOUNT}"></div><div id="${BOTTOM_MOUNT}"></div>`;
});
afterEach(() => vi.unstubAllGlobals());

const top = () => document.getElementById(TOP_MOUNT)!;
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('9: every call is under the site base', () => {
  it('API and history paths', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        return new Response(url.includes('_history') ? 'old' : '[]', { status: 200 });
      }),
    );
    const api = apiFor('/fixture/');
    await api.me();
    await api.pages();
    await api.comments('guide/index');
    await api.statuses();
    await api.tickets('a b');
    await api.comment({ page: 'p', heading: 'h', quote: 'q', body: 'b' });
    await api.reply('t1', 'r');
    await api.resolve('t1', 7);
    await api.reopen('t1');
    await api.setStatus({ page: 'p', status: 'ready', expectedVersion: 0, hash: 'h' });
    await api.oldVersion('c'.repeat(40), 'guide/index.md');
    expect(urls).toEqual([
      '/fixture/_api/me',
      '/fixture/_api/pages',
      '/fixture/_api/comments?page=guide%2Findex',
      '/fixture/_api/status',
      '/fixture/_api/tickets?page=a%20b',
      '/fixture/_api/comments',
      '/fixture/_api/comments/t1/replies',
      '/fixture/_api/comments/t1/resolve',
      '/fixture/_api/comments/t1/reopen',
      '/fixture/_api/status',
      `/fixture/_history/${'c'.repeat(40)}/guide/index.md`,
    ]);
  });
});

describe('10, 11: history only when the hub sends it', () => {
  it('a reader gets no history list; the team does', async () => {
    const reader: Me = { email: 'r@x.example', role: 'reader' };
    await createReview(fakeApi(reader, { commit: 'c', pages: { signup: PAGE } }), '/fixture/').render('signup');
    expect(top().querySelector('.rv-status')).not.toBeNull();
    expect(top().querySelector('.rv-history')).toBeNull();
    const team: Me = { email: 'dev@x.example', role: 'team' };
    await createReview(
      fakeApi(team, { commit: 'c', pages: { signup: { ...PAGE, history: HISTORY } } }),
      '/fixture/',
    ).render('signup');
    expect(top().querySelector('.rv-history')?.textContent).toContain('History (1)');
  });

  it('13: the index adds the status board under its own comments', async () => {
    const reader: Me = { email: 'r@x.example', role: 'reader' };
    await createReview(fakeApi(reader, { commit: 'c', pages: { index: PAGE } }), '/fixture/').render('index');
    const bottom = document.getElementById(BOTTOM_MOUNT)!;
    expect(bottom.querySelector('#rv-comments')).not.toBeNull();
    expect([...bottom.querySelectorAll('.rv-board a')].map((a) => a.getAttribute('href'))).toEqual([
      '/fixture/',
      '/fixture/signup',
    ]);
    expect(top().querySelector('.rv-status')).not.toBeNull();
  });
});

describe('26: an expired sign-in', () => {
  const expired = () => Promise.reject(new ApiError(401, 'UNAUTHORIZED', 'Sign in to use this.'));

  it('while loading page data or who I am: a notice, nothing half drawn, no unhandled rejection', async () => {
    const reader: Me = { email: 'r@x.example', role: 'reader' };
    for (const over of [{ pages: expired }, { me: expired }] as Partial<Api>[]) {
      document.getElementById(TOP_MOUNT)!.replaceChildren();
      await createReview(fakeApi(reader, { commit: 'c', pages: { signup: PAGE } }, over), '/fixture/').render('signup');
      expect(top().textContent).toContain('Your sign-in has expired');
      expect(top().querySelector('.rv-status')).toBeNull();
    }
  });

  it('on a write: the notice, and the page stays', async () => {
    const team: Me = { email: 'dev@x.example', role: 'team' };
    const api = fakeApi(team, { commit: 'c', pages: { signup: PAGE } }, { setStatus: expired });
    await createReview(api, '/fixture/').render('signup');
    const move = [...top().querySelectorAll('button')].find((b) => b.textContent?.startsWith('Move to'))!;
    move.click();
    await settle();
    await settle();
    expect(top().textContent).toContain('Your sign-in has expired');
    expect(top().querySelector('.rv-status')).not.toBeNull();
  });
});

describe('navigation and actions', () => {
  const team: Me = { email: 'dev@x.example', role: 'team' };
  const pages: Pages = { commit: 'c', pages: { a: PAGE, b: { ...PAGE, title: 'B' } } };

  it('a write that finishes after the reader moved on does not redraw the old page', async () => {
    let finish!: () => void;
    const slow = () => new Promise<{ labels: string }>((resolve) => (finish = () => resolve({ labels: 'none' })));
    const statusesFor = async () => [
      { ...status, page: 'a' },
      { ...status, page: 'b', title: 'B' },
    ];
    const calls: string[] = [];
    const api = fakeApi(team, pages, {
      setStatus: slow,
      statuses: statusesFor,
      comments: async (page: string) => {
        calls.push(page);
        return [];
      },
    });
    const review = createReview(api, '/fixture/');
    await review.render('a');
    [...top().querySelectorAll('button')].find((b) => b.textContent?.startsWith('Move to'))!.click();
    await review.render('b');
    calls.length = 0;
    finish();
    await settle();
    await settle();
    expect(calls).toEqual([]);
  });

  it("a new page removes the last page's Comment button", async () => {
    const review = createReview(fakeApi(team, pages), '/fixture/');
    await review.render('a');
    const stray = document.createElement('button');
    stray.className = 'rv-pop';
    document.body.append(stray);
    await review.render('b');
    expect(document.querySelector('.rv-pop')).toBeNull();
  });

  it('cancelling the PR question does not resolve; an empty answer resolves with no PR', async () => {
    const resolved: (number | undefined)[] = [];
    const thread = {
      id: 't1',
      heading: 'limits',
      quote: 'q',
      pageHash: 'h',
      author: 'dev@x.example',
      mine: true,
      body: 'b',
      state: 'open' as const,
      resolvedBy: null,
      resolvedPr: null,
      resolvedAt: null,
      createdAt: '2026-10-07T00:00:00Z',
      outdated: false,
      replies: [],
    };
    const api = fakeApi(team, pages, {
      statuses: async () => [{ ...status, page: 'a' }],
      comments: async () => [thread],
      resolve: async (_id: string, pr?: number) => {
        resolved.push(pr);
        return {};
      },
    });
    await createReview(api, '/fixture/').render('a');
    const resolveButton = () =>
      [...document.querySelectorAll('#rv-comments button')].find((b) => b.textContent === 'Resolve') as HTMLElement;
    vi.stubGlobal('prompt', () => null);
    resolveButton().click();
    await settle();
    expect(resolved).toEqual([]);
    vi.stubGlobal('prompt', () => '');
    resolveButton().click();
    await settle();
    expect(resolved).toEqual([undefined]);
  });
});
