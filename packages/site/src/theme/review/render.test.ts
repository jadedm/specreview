// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { Me, Thread } from './api';
import { canSettle, commentsBlock, hrefOf, statusBar, statusBoard, ticketBox } from './render';
import { oldVersionView } from './render-history';
import { keyIn, pageKeyOf, pathOf } from './start';

const reader: Me = { email: 'riya@ariai.example', role: 'reader' };
const approver: Me = { email: 'pm@inoltro.ai', role: 'approver' };
const noop = { reply: () => {}, resolve: () => {}, reopen: () => {}, viewOld: () => {} };
const HOSTILE = '<script>window.hit=1</script><img src=x onerror="window.hit=1"><svg onload="window.hit=1"></svg>';

const thread = (over: Partial<Thread> = {}): Thread => ({
  id: 't1',
  heading: 'limits',
  quote: HOSTILE,
  pageHash: 'h',
  author: 'Reader',
  mine: false,
  body: HOSTILE,
  state: 'open',
  resolvedBy: null,
  resolvedPr: null,
  resolvedAt: null,
  createdAt: '2026-10-07T00:00:00Z',
  outdated: false,
  replies: [{ id: 'r1', author: 'Inoltro team', mine: false, body: HOSTILE, createdAt: '2026-10-07T00:00:00Z' }],
  ...over,
});

const noActiveContent = (node: Element) => {
  expect(node.querySelector('script, img, svg, iframe, [onerror], [onload]')).toBeNull();
};

describe('47: untrusted text is shown as text', () => {
  it('comment bodies, quotes and replies', () => {
    const block = commentsBlock([{ id: 'limits', title: 'Limits', text: '' }], [thread()], reader, noop);
    noActiveContent(block);
    expect(block.textContent).toContain('<script>window.hit=1</script>');
  });

  it('ticket titles', () => {
    const box = ticketBox([
      {
        number: 52,
        title: HOSTILE,
        state: 'open',
        url: 'https://github.com/inoltrotech/sidecar/issues/52',
        labels: [],
        fetchedAt: '2026-10-07T00:00:00Z',
        stale: false,
      },
    ])!;
    noActiveContent(box);
    expect(box.textContent).toContain('onerror');
  });

  it('old Markdown: raw HTML and javascript links do not become active', () => {
    const md = `# Old\n\n${HOSTILE}\n\n[click](javascript:alert(1)) [ok](https://inoltro.ai)\n\n<a href="javascript:alert(1)">x</a>`;
    const view = oldVersionView(
      { commit: 'c', date: '2026-10-03T00:00:00Z', author: 'm', pr: 51, path: 'p.md', hash: 'h' },
      md,
      () => {},
    );
    noActiveContent(view);
    const hrefs = [...view.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['https://inoltro.ai']);
    const withImage = oldVersionView(
      { commit: 'c', date: '2026-10-03T00:00:00Z', author: 'm', pr: 51, path: 'p.md', hash: 'h' },
      '![x](data:image/png;base64,AAAA) ![y](https://inoltro.ai/a.png)',
      () => {},
    );
    expect([...withImage.querySelectorAll('img')].map((i) => i.getAttribute('src'))).toEqual([
      'https://inoltro.ai/a.png',
    ]);
    expect(view.querySelector('h1')?.textContent).toBe('Old');
  });
});

describe('status controls follow the role', () => {
  const status = {
    page: 'p',
    title: 'P',
    hash: 'h',
    status: 'in_review' as const,
    version: 1,
    changedBy: 'dev@inoltro.ai',
    changedAt: '2026-10-07T00:00:00Z',
    wasReadyAt: null,
  };
  it('a reader sees no buttons; an approver sees ready, disabled while comments are open', () => {
    expect(statusBar(status, reader, 0, { set: () => {} }).querySelectorAll('button')).toHaveLength(0);
    const bar = statusBar(status, approver, 2, { set: () => {} });
    const ready = [...bar.querySelectorAll('button')].find((b) => b.textContent === 'Mark ready to build');
    expect(ready?.disabled).toBe(true);
    const clear = statusBar(status, approver, 0, { set: () => {} });
    expect([...clear.querySelectorAll('button')].find((b) => b.textContent === 'Mark ready to build')?.disabled).toBe(
      false,
    );
  });
});

describe('9, 22: page keys under the base', () => {
  it('map routes under /fixture/ to manifest keys', () => {
    const base = '/fixture/';
    expect(pageKeyOf('/fixture/', base)).toBe('index');
    expect(pageKeyOf('/fixture', base)).toBe('index');
    expect(pageKeyOf('/fixture/onboarding/signup', base)).toBe('onboarding/signup');
    expect(pageKeyOf('/fixture/onboarding/signup.html', base)).toBe('onboarding/signup');
    // A trailing slash is the folder's own page, as the hub serves it.
    expect(pageKeyOf('/fixture/guide/', base)).toBe('guide/index');
    expect(pageKeyOf('/fixture/guide', base)).toBe('guide');
    expect(pageKeyOf('/fixture/guide/index.html', base)).toBe('guide/index');
    expect(pageKeyOf('/fixture/release-1.2', base)).toBe('release-1.2');
    expect(pageKeyOf(pathOf('/fixture/onboarding/roster?x=1#the-join-link', 'http://h'), base)).toBe(
      'onboarding/roster',
    );
  });

  it('a folder resolves to its index unless a page of that name exists', () => {
    const pages = { guide: {}, 'guide/index': {}, 'notes.v2/index': {} } as never;
    expect(keyIn(pages, 'guide')).toBe('guide');
    expect(keyIn(pages, 'guide/index')).toBe('guide/index');
    expect(keyIn(pages, 'notes.v2')).toBe('notes.v2/index');
    expect(keyIn(pages, 'missing')).toBeNull();
  });

  it('13: board links go back to those addresses', () => {
    expect(hrefOf('index', '/fixture/')).toBe('/fixture/');
    expect(hrefOf('guide/index', '/fixture/')).toBe('/fixture/guide/');
    expect(hrefOf('release-1.2', '/fixture/')).toBe('/fixture/release-1.2');
  });
});

describe('old versions are offered to the team only', () => {
  it('an outdated thread shows the link to the team, not to a reader', () => {
    const team: Me = { email: 'dev@inoltro.ai', role: 'team' };
    const t = thread({ outdated: true, body: 'x', quote: 'q', replies: [] });
    const has = (me: Me) =>
      [...commentsBlock([], [t], me, noop).querySelectorAll('button')].some(
        (b) => b.textContent === 'See the text it was about',
      );
    expect(has(team)).toBe(true);
    expect(has(reader)).toBe(false);
  });
});

describe('a hidden quote', () => {
  it('shows a note instead of the removed text', () => {
    const t = thread({ outdated: true, quote: '', quoteHidden: true, body: 'x', replies: [] });
    const block = commentsBlock([], [t], reader, noop);
    expect(block.querySelector('.rv-quote')?.textContent).toBe('The quoted text is no longer on this page.');
  });
});

describe('10, 25: what a reader sees is what the hub sends', () => {
  const readerThreads = [
    thread({ id: 'a', author: 'You', mine: true, body: 'mine', quote: 'q', replies: [] }),
    thread({ id: 'b', author: 'Inoltro team', body: 'team', quote: 'q', replies: [] }),
    thread({
      id: 'c',
      author: 'Reader',
      body: 'other',
      quote: 'q',
      state: 'resolved',
      resolvedBy: 'Inoltro team',
      replies: [{ id: 'r', author: 'You', mine: true, body: 'r', createdAt: '2026-10-07T00:00:00Z' }],
    }),
  ];

  it('labels are shown as sent, and no email appears', () => {
    const block = commentsBlock([], readerThreads, reader, noop);
    const text = block.textContent ?? '';
    for (const label of ['You,', 'Inoltro team,', 'Reader,', 'Resolved by Inoltro team']) expect(text).toContain(label);
    expect(text).not.toMatch(/@/);
  });

  it('resolve is offered on their own threads only; the team may settle any', () => {
    expect(readerThreads.map((t) => canSettle(t, reader))).toEqual([true, false, false]);
    const team: Me = { email: 'dev@inoltro.ai', role: 'team' };
    expect(readerThreads.map((t) => canSettle(t, team))).toEqual([true, true, true]);
    const resolveButtons = (id: string) =>
      [...commentsBlock([], readerThreads, reader, noop).querySelectorAll(`[data-id="${id}"] button`)].map(
        (b) => b.textContent,
      );
    expect(resolveButtons('a')).toContain('Resolve');
    expect(resolveButtons('b')).not.toContain('Resolve');
  });

  it("tickets without title or link show the number, state and label; the team's are linked", () => {
    const box = ticketBox([
      { number: 52, state: 'open', labels: ['docs: in review'], fetchedAt: '2026-10-07T00:00:00Z', stale: false },
      { number: 23, unavailable: true },
    ])!;
    expect(box.querySelector('a')).toBeNull();
    expect(box.textContent).toContain('#52 (open, docs: in review)');
    expect(box.textContent).toContain('#23: could not load');
    const team = ticketBox([
      {
        number: 52,
        title: 'Company approval',
        url: 'https://github.com/o/r/issues/52',
        state: 'open',
        labels: [],
        fetchedAt: '2026-10-07T00:00:00Z',
        stale: false,
      },
    ])!;
    expect(team.querySelector('a')?.getAttribute('href')).toBe('https://github.com/o/r/issues/52');
    expect(team.textContent).toContain('Company approval');
  });

  it('13: the status board shows changedBy as sent and links under the base', () => {
    const board = statusBoard(
      [
        {
          page: 'guide/index',
          title: 'Guide',
          hash: 'h',
          status: 'ready',
          version: 1,
          changedBy: 'Inoltro team',
          changedAt: '2026-10-07T00:00:00Z',
          wasReadyAt: null,
        },
      ],
      '/fixture/',
    );
    expect(board.querySelector('a')?.getAttribute('href')).toBe('/fixture/guide/');
    expect(board.textContent).toContain('Inoltro team');
  });
});
