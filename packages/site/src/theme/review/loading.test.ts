// @vitest-environment happy-dom
// #31: loading placeholders and held actions. Case numbers are the ticket's.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Api, apiFor, ApiError, type Me, type Pages, type Thread } from './api';
import { ANNOUNCE_DELAY_MS, LOADING_TEXT } from './skeleton';
import { BOTTOM_MOUNT, createReview, NO_STATUS, SAVED_NOT_RELOADED, TOP_MOUNT, UNRESERVED } from './start';

const HISTORY = [
  { commit: 'a'.repeat(40), date: '2026-10-07T00:00:00Z', author: 'Dev', pr: 2, path: 'p.md', hash: 'h' },
];
const PAGE = { title: 'A', hash: 'h', issues: [], sections: [{ id: 'limits', title: 'Limits', text: 'x' }] };
const PAGES: Pages = { commit: 'c', pages: { a: { ...PAGE, history: HISTORY }, b: { ...PAGE, title: 'B' } } };
const status = (page: string) => ({
  page,
  title: page,
  hash: 'h',
  status: 'pending' as const,
  version: 0,
  changedBy: null,
  changedAt: null,
  wasReadyAt: null,
});
const thread = (body: string): Thread => ({
  id: `t-${body}`,
  heading: 'limits',
  quote: 'q',
  pageHash: 'h',
  author: 'dev@x.example',
  mine: true,
  body,
  state: 'open',
  resolvedBy: null,
  resolvedPr: null,
  resolvedAt: null,
  createdAt: '2026-10-07T00:00:00Z',
  outdated: false,
  replies: [],
});
const team: Me = { email: 'dev@x.example', role: 'team' };
const approver: Me = { email: 'pm@x.example', role: 'approver' };

const fakeApi = (me: Me, over: Partial<Api> = {}): Api =>
  ({
    me: async () => me,
    pages: async () => PAGES,
    comments: async (page: string) => [thread(`on ${page}`)],
    statuses: async () => [status('a'), status('b')],
    tickets: async () => [],
    ...over,
  }) as Api;

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
};
const expired = () => new ApiError(401, 'UNAUTHORIZED', 'Sign in to use this.');

beforeEach(() => {
  document.body.innerHTML = `<div class="vp-doc"><div><h2 id="limits">Limits</h2><p>Some page text here</p></div></div><div id="${TOP_MOUNT}"></div><div id="${BOTTOM_MOUNT}"></div>`;
});
// Each review listens for selections on the document, which outlives a test;
// remove what a test added so an earlier review cannot answer a later one.
const added: [string, EventListenerOrEventListenerObject][] = [];
const addListener = document.addEventListener.bind(document);
beforeEach(() => {
  vi.spyOn(document, 'addEventListener').mockImplementation((type, listener, options) => {
    added.push([type, listener]);
    addListener(type, listener, options);
  });
});
afterEach(() => {
  for (const [type, listener] of added.splice(0)) document.removeEventListener(type, listener);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const top = () => document.getElementById(TOP_MOUNT)!;
const bottom = () => document.getElementById(BOTTOM_MOUNT)!;
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
const button = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text)!;
const writeControls = () => [
  ...document.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>(
    `#${TOP_MOUNT} button[data-write], #${BOTTOM_MOUNT} button[data-write], #${TOP_MOUNT} textarea, #${BOTTOM_MOUNT} textarea`,
  ),
];
const notice = () => top().querySelector('[role="alert"]')?.textContent ?? null;
// Selects the first words of the page text, as a reader would, and lets go.
const selectText = () => {
  const text = document.querySelector('.vp-doc p')!.firstChild!;
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, 9);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  document.querySelector('.vp-doc p')!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
};

describe('31: placeholders while a page loads', () => {
  it('1, 2, 25: placeholders with a status region until the data arrives, then the panel', async () => {
    const pages = deferred<Pages>();
    const done = createReview(fakeApi(team, { pages: () => pages.promise }), '/fixture/').render('a');
    const region = top().querySelector('.rv-skel[role="status"]');
    // In empty, then the text: a change screen readers announce.
    await settle();
    expect(region?.textContent).toBe('');
    await new Promise((r) => setTimeout(r, ANNOUNCE_DELAY_MS + 20));
    expect(region?.textContent).toBe(LOADING_TEXT);
    expect(region?.hasAttribute('aria-busy')).toBe(false);
    expect(top().classList.contains(UNRESERVED)).toBe(false);
    expect(region?.hasAttribute('aria-label')).toBe(false);
    expect(bottom().querySelector('.rv-skel')).not.toBeNull();
    expect(top().querySelector('.rv-status')).toBeNull();
    expect(bottom().querySelector('.rv-thread[data-id]')).toBeNull();
    pages.resolve(PAGES);
    await done;
    expect(document.querySelector('.rv-skel')).toBeNull();
    expect(top().querySelector('.rv-status')).not.toBeNull();
    expect(bottom().textContent).toContain('on a');
  });

  it('15: placeholder markup has no style attribute and its bars are hidden from screen readers', async () => {
    const pages = deferred<Pages>();
    void createReview(fakeApi(team, { pages: () => pages.promise }), '/fixture/').render('a');
    await settle();
    const nodes = [...document.querySelectorAll('.rv-skel, .rv-skel *')];
    expect(nodes.length).toBeGreaterThan(5);
    expect(nodes.filter((n) => n.hasAttribute('style'))).toEqual([]);
    const bars = [...document.querySelectorAll('.rv-skel-bar')];
    expect(bars.length).toBeGreaterThan(0);
    expect(bars.every((b) => b.getAttribute('aria-hidden') === 'true')).toBe(true);
  });

  it('3, 21: any of the five calls failing clears the placeholders and shows a notice', async () => {
    for (const call of ['pages', 'me', 'comments', 'statuses', 'tickets'] as const) {
      top().replaceChildren();
      bottom().replaceChildren();
      const failing = { [call]: () => Promise.reject(expired()) } as Partial<Api>;
      await createReview(fakeApi(team, failing), '/fixture/').render('a');
      expect(document.querySelector('.rv-skel'), call).toBeNull();
      expect(notice(), call).toContain('Your sign-in has expired');
      expect(top().querySelector('.rv-status'), call).toBeNull();
      expect(bottom().children.length, call).toBe(0);
      expect(top().classList.contains(UNRESERVED), call).toBe(true);
    }
  });

  it('21: an error whose body is not JSON gives the generic notice', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('_api/comments')) return new Response('<html>bad gateway</html>', { status: 502 });
        if (url.endsWith('_api/me')) return Response.json(team);
        if (url.endsWith('_api/pages')) return Response.json(PAGES);
        if (url.endsWith('_api/status')) return Response.json([status('a')]);
        return Response.json([]);
      }),
    );
    await createReview(apiFor('/fixture/'), '/fixture/').render('a');
    expect(document.querySelector('.rv-skel')).toBeNull();
    // #29: an error the hub did not explain names its status.
    expect(notice()).toBe('Something went wrong (HTTP 502). Reload and try again.');
  });

  it('4: a route that is not a reviewed page leaves both mounts empty', async () => {
    await createReview(fakeApi(team), '/fixture/').render('not-a-page');
    expect(top().children.length).toBe(0);
    expect(bottom().children.length).toBe(0);
    expect(top().classList.contains(UNRESERVED)).toBe(true);
  });

  it('22: a listed page with no status row is a notice, not an empty panel', async () => {
    await createReview(fakeApi(team, { statuses: async () => [status('b')] }), '/fixture/').render('a');
    expect(document.querySelector('.rv-skel')).toBeNull();
    expect(notice()).toBe(NO_STATUS);
    expect(top().querySelector('.rv-status')).toBeNull();
  });

  it('5: a slow load of the last page does not draw over the new one', async () => {
    const slowA = deferred<Thread[]>();
    const review = createReview(
      fakeApi(team, { comments: (page: string) => (page === 'a' ? slowA.promise : Promise.resolve([thread('on b')])) }),
      '/fixture/',
    );
    const loadingA = review.render('a');
    await settle();
    await review.render('b');
    slowA.resolve([thread('on a')]);
    await loadingA;
    await settle();
    expect(bottom().textContent).toContain('on b');
    expect(bottom().textContent).not.toContain('on a');
  });

  it('6: a slow load of the last page that fails puts no notice on the new one', async () => {
    const slowA = deferred<Thread[]>();
    const review = createReview(
      fakeApi(team, { comments: (page: string) => (page === 'a' ? slowA.promise : Promise.resolve([thread('on b')])) }),
      '/fixture/',
    );
    const loadingA = review.render('a');
    await settle();
    await review.render('b');
    slowA.reject(expired());
    await loadingA;
    await settle();
    expect(notice()).toBeNull();
    expect(top().querySelector('.rv-status')).not.toBeNull();
    expect(bottom().textContent).toContain('on b');
  });
});

describe('31: actions hold the panel while they run', () => {
  it('7, 8, 24: the button shows its working label, write controls are held, a second write is ignored, reading stays usable', async () => {
    const write = deferred<{ labels: string }>();
    const setStatus = vi.fn(() => write.promise);
    const resolve = vi.fn(async () => ({}));
    vi.stubGlobal('prompt', () => '');
    await createReview(fakeApi(team, { setStatus, resolve }), '/fixture/').render('a');
    const move = button('Move to in review');
    move.click();
    expect(move.textContent).toBe('Saving');
    expect(move.disabled).toBe(true);
    expect(move.getAttribute('aria-busy')).toBe('true');
    expect(writeControls().length).toBeGreaterThan(3);
    expect(writeControls().every((c) => c.disabled)).toBe(true);
    expect(top().getAttribute('aria-busy')).toBe('true');
    const reading = [...top().querySelectorAll<HTMLButtonElement>('button:not([data-write])')];
    expect(reading.length).toBeGreaterThan(0);
    expect(reading.every((b) => !b.disabled)).toBe(true);
    move.click();
    button('Resolve').click();
    // A control that escaped the hold still cannot start a second write.
    const resolveButton = button('Resolve');
    resolveButton.disabled = false;
    resolveButton.click();
    await settle();
    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('9: a successful write redraws without placeholders, the status bar never missing', async () => {
    const write = deferred<{ labels: string }>();
    const reload = deferred<Thread[]>();
    let calls = 0;
    const setStatus = vi.fn(() => (calls === 1 ? write.promise : Promise.resolve({ labels: 'none' })));
    const comments = vi.fn(() => (++calls === 1 ? Promise.resolve([thread('first')]) : reload.promise));
    await createReview(fakeApi(team, { setStatus, comments }), '/fixture/').render('a');
    button('Move to in review').click();
    write.resolve({ labels: 'updated' });
    await settle();
    expect(comments).toHaveBeenCalledTimes(2);
    expect(top().querySelector('.rv-status')).not.toBeNull();
    expect(document.querySelector('.rv-skel')).toBeNull();
    expect(top().getAttribute('aria-busy')).toBe('true');
    reload.resolve([thread('second')]);
    await settle();
    expect(bottom().textContent).toContain('second');
    expect(document.querySelector('[aria-busy]')).toBeNull();
    expect(writeControls().some((c) => !c.disabled)).toBe(true);
    button('Move to in review').click();
    expect(setStatus).toHaveBeenCalledTimes(2);
  });

  it('10: a failed write puts every control back as it was, a blocked "Mark ready" stays blocked', async () => {
    const setStatus = vi.fn(() => Promise.reject(expired()));
    await createReview(fakeApi(approver, { setStatus }), '/fixture/').render('a');
    const before = writeControls().map((c) => [c.textContent, c.disabled]);
    expect(button('Mark ready to build').disabled).toBe(true);
    button('Move to in review').click();
    await settle();
    expect(notice()).toContain('Your sign-in has expired');
    expect(writeControls().map((c) => [c.textContent, c.disabled])).toEqual(before);
    expect(button('Mark ready to build').disabled).toBe(true);
    expect(document.querySelector('[aria-busy]')).toBeNull();
  });

  it('13: cancelling the PR question leaves nothing held', async () => {
    const resolve = vi.fn(async () => ({}));
    vi.stubGlobal('prompt', () => null);
    await createReview(fakeApi(team, { resolve }), '/fixture/').render('a');
    button('Resolve').click();
    await settle();
    expect(resolve).not.toHaveBeenCalled();
    expect(button('Resolve').disabled).toBe(false);
    expect(document.querySelector('[aria-busy]')).toBeNull();
  });

  it('23: saved but not redrawn keeps the panel held with its own notice', async () => {
    let calls = 0;
    const comments = vi.fn(() =>
      ++calls === 1 ? Promise.resolve([thread('first')]) : Promise.reject(new ApiError(503, 'X', 'down')),
    );
    const setStatus = vi.fn(async () => ({ labels: 'updated' }));
    await createReview(fakeApi(team, { setStatus, comments }), '/fixture/').render('a');
    button('Move to in review').click();
    await settle();
    expect(notice()).toBe(SAVED_NOT_RELOADED);
    expect(writeControls().every((c) => c.disabled)).toBe(true);
    expect(button('Move to in review').getAttribute('aria-busy')).toBeNull();
    expect(document.querySelector('[aria-busy]')).toBeNull();
  });
});

describe('31: results belong to the page that started them', () => {
  const pagesWith = (over: Partial<Api>) =>
    fakeApi(team, {
      comments: async (page: string) => [thread(`on ${page}`)],
      ...over,
    });

  it('14, 20: a write that fails after the reader moved on puts no notice on the new page', async () => {
    const write = deferred<{ labels: string }>();
    const review = createReview(pagesWith({ setStatus: () => write.promise }), '/fixture/');
    await review.render('a');
    button('Move to in review').click();
    await review.render('b');
    write.reject(new ApiError(409, 'CONFLICT', 'Changed meanwhile.'));
    await settle();
    expect(notice()).toBeNull();
    expect(bottom().textContent).toContain('on b');
    expect(document.querySelector('[aria-busy]')).toBeNull();
    button('Move to in review').click();
    expect(button('Saving')).toBeDefined();
  });

  it('19: a redraw that started before the reader moved on does not draw on the new page', async () => {
    const reload = deferred<Thread[]>();
    let aCalls = 0;
    const review = createReview(
      pagesWith({
        setStatus: async () => ({ labels: 'updated' }),
        comments: (page: string) => {
          if (page === 'b') return Promise.resolve([thread('on b')]);
          return ++aCalls === 1 ? Promise.resolve([thread('on a')]) : reload.promise;
        },
      }),
      '/fixture/',
    );
    await review.render('a');
    button('Move to in review').click();
    await settle();
    expect(aCalls).toBe(2);
    await review.render('b');
    reload.resolve([thread('late a')]);
    await settle();
    expect(bottom().textContent).toContain('on b');
    expect(bottom().textContent).not.toContain('late a');
    expect(notice()).toBeNull();
  });

  it("19: a late redraw from the last page does not release the new page's write", async () => {
    const reload = deferred<Thread[]>();
    const writeB = deferred<{ labels: string }>();
    let aCalls = 0;
    const setStatus = vi.fn((s: { page: string }) =>
      s.page === 'a' ? Promise.resolve({ labels: 'updated' }) : writeB.promise,
    );
    const review = createReview(
      pagesWith({
        setStatus,
        comments: (page: string) => {
          if (page === 'b') return Promise.resolve([thread('on b')]);
          return ++aCalls === 1 ? Promise.resolve([thread('on a')]) : reload.promise;
        },
      }),
      '/fixture/',
    );
    await review.render('a');
    button('Move to in review').click();
    await settle();
    await review.render('b');
    button('Move to in review').click();
    reload.resolve([thread('late a')]);
    await settle();
    expect(button('Saving').disabled).toBe(true);
    selectText();
    expect(document.querySelector('.rv-pop')).toBeNull();
  });

  it('a write from an earlier visit to the same page does not draw over the current visit', async () => {
    const first = deferred<{ labels: string }>();
    const second = deferred<{ labels: string }>();
    let writes = 0;
    let aComments = 0;
    const review = createReview(
      pagesWith({
        setStatus: () => (++writes === 1 ? first.promise : second.promise),
        comments: async (page: string) => {
          if (page === 'a') aComments++;
          return [thread(`on ${page}`)];
        },
      }),
      '/fixture/',
    );
    await review.render('a');
    button('Move to in review').click();
    await review.render('b');
    await review.render('a');
    button('Move to in review').click();
    const loadsBefore = aComments;
    first.resolve({ labels: 'updated' });
    await settle();
    expect(aComments).toBe(loadsBefore);
    expect(button('Saving').disabled).toBe(true);
    expect(top().getAttribute('aria-busy')).toBe('true');
  });

  it('a history view that fails after the reader moved on puts no notice on the new page', async () => {
    const old = deferred<string>();
    const review = createReview(pagesWith({ oldVersion: () => old.promise }), '/fixture/');
    await review.render('a');
    const view = [...top().querySelectorAll<HTMLButtonElement>('button:not([data-write])')].find((b) =>
      /view|see/i.test(b.textContent ?? ''),
    )!;
    expect(view).toBeDefined();
    view.click();
    await review.render('b');
    old.reject(new ApiError(503, 'X', 'down'));
    await settle();
    expect(notice()).toBeNull();
  });
});

describe('31: the comment form', () => {
  const openForm = () => {
    selectText();
    (document.querySelector('.rv-pop') as HTMLButtonElement).click();
    const form = document.querySelector('.rv-form')!;
    (form.querySelector('textarea') as HTMLTextAreaElement).value = 'a new comment';
    return form;
  };

  it('11: Post shows "Posting", posts once for a double click, then the form goes and the panel redraws', async () => {
    const posted = deferred<{ id: string }>();
    const comment = vi.fn(() => posted.promise);
    await createReview(fakeApi(team, { comment }), '/fixture/').render('a');
    openForm();
    const post = button('Post');
    post.click();
    post.click();
    expect(post.textContent).toBe('Posting');
    expect(post.disabled).toBe(true);
    expect(comment).toHaveBeenCalledTimes(1);
    expect(comment).toHaveBeenCalledWith({ page: 'a', heading: 'limits', quote: 'Some page', body: 'a new comment' });
    posted.resolve({ id: 'n' });
    await settle();
    expect(document.querySelector('.rv-form')).toBeNull();
    expect(top().querySelector('.rv-status')).not.toBeNull();
  });

  it('8: no Comment button is offered while another write runs, and one is once it ends', async () => {
    const write = deferred<{ labels: string }>();
    await createReview(fakeApi(team, { setStatus: () => write.promise }), '/fixture/').render('a');
    selectText();
    expect(document.querySelector('.rv-pop')).not.toBeNull();
    button('Move to in review').click();
    expect(document.querySelector('.rv-pop')).toBeNull();
    selectText();
    expect(document.querySelector('.rv-pop')).toBeNull();
    write.resolve({ labels: 'updated' });
    await settle();
    selectText();
    expect(document.querySelector('.rv-pop')).not.toBeNull();
  });

  it('12: a failed post keeps the form and its text, and Post works again', async () => {
    const comment = vi.fn(() => Promise.reject(new ApiError(429, 'RATE_LIMITED', 'Too many writes.')));
    await createReview(fakeApi(team, { comment }), '/fixture/').render('a');
    const form = openForm();
    button('Post').click();
    await settle();
    expect(notice()).toBe('Too many writes.');
    expect(document.querySelector('.rv-form')).toBe(form);
    expect((form.querySelector('textarea') as HTMLTextAreaElement).value).toBe('a new comment');
    expect(button('Post').disabled).toBe(false);
  });
});
