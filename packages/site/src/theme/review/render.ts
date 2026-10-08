import type { Section, Status } from '@specreview/shared';
import type { Me, PageStatus, Thread, Ticket } from './api';
import { el, when } from './dom';

export const STATUS_TEXT: Record<Status, string> = {
  pending: 'Pending',
  in_review: 'In review',
  ready: 'Ready to build',
};

// The hub decides who may resolve; this only hides a button that would be refused.
export const canSettle = (thread: Thread, me: Me) => me.role !== 'reader' || thread.mine;

// ---- status ----

type StatusActions = { set: (status: Status) => void };

export const statusBar = (status: PageStatus, me: Me, openCount: number, actions: StatusActions) => {
  const targets: Status[] = (['pending', 'in_review', 'ready'] as Status[]).filter((s) => s !== status.status);
  const allowed = (s: Status) => (s === 'ready' ? me.role === 'approver' : me.role !== 'reader');
  const buttons = targets.filter(allowed).map((s) => {
    const blocked = s === 'ready' && openCount > 0;
    return el(
      'button',
      {
        class: 'rv-btn',
        disabled: blocked,
        title: blocked ? 'Resolve the open comments first' : '',
        onclick: () => actions.set(s),
      },
      s === 'ready' ? 'Mark ready to build' : `Move to ${STATUS_TEXT[s].toLowerCase()}`,
    );
  });
  return el(
    'div',
    { class: 'rv-status', 'data-status': status.status },
    el('span', { class: 'rv-badge' }, STATUS_TEXT[status.status]),
    status.changedAt
      ? el('span', { class: 'rv-muted' }, `${when(status.changedAt)} by ${status.changedBy ?? ''}`)
      : null,
    status.wasReadyAt
      ? el('span', { class: 'rv-muted' }, `Was ready on ${when(status.wasReadyAt)}, changed since`)
      : null,
    el('span', { class: 'rv-muted' }, `${openCount} open comment${openCount === 1 ? '' : 's'}`),
    ...buttons,
  );
};

// ---- tickets ----

export const ticketBox = (tickets: Ticket[]) =>
  tickets.length === 0
    ? null
    : el(
        'div',
        { class: 'rv-tickets' },
        el('strong', {}, 'Tickets'),
        el(
          'ul',
          {},
          ...tickets.map((t) => {
            if ('notFound' in t) return el('li', {}, `#${t.number}: not found`);
            if ('unavailable' in t) return el('li', {}, `#${t.number}: could not load from GitHub`);
            // Readers get no title or link: the number and status are theirs.
            const number = t.url ? el('a', { href: t.url, rel: 'noreferrer' }, `#${t.number}`) : `#${t.number}`;
            return el(
              'li',
              {},
              number,
              t.title ? ` ${t.title} ` : ' ',
              el('span', { class: 'rv-muted' }, `(${t.state}${t.labels.length ? `, ${t.labels.join(', ')}` : ''})`),
              t.stale ? el('span', { class: 'rv-muted' }, ` as of ${when(t.fetchedAt)}`) : null,
            );
          }),
        ),
      );

// ---- comments ----

type ThreadActions = {
  reply: (thread: Thread, body: string) => void;
  resolve: (thread: Thread, pr?: number) => void;
  reopen: (thread: Thread) => void;
  viewOld: (thread: Thread) => void;
};

const message = (author: string, at: string, body: string) =>
  el('div', { class: 'rv-msg' }, el('div', { class: 'rv-muted' }, `${author}, ${when(at)}`), el('p', {}, body));

export const threadCard = (thread: Thread, me: Me, actions: ThreadActions) => {
  const replyBox = el('textarea', { class: 'rv-input', rows: '2', maxlength: '5000', placeholder: 'Reply' });
  const settle = canSettle(thread, me);
  return el(
    'div',
    { class: 'rv-thread', 'data-state': thread.state, 'data-id': thread.id },
    thread.quoteHidden
      ? el('blockquote', { class: 'rv-quote' }, 'The quoted text is no longer on this page.')
      : el('blockquote', { class: 'rv-quote' }, thread.quote),
    message(thread.author, thread.createdAt, thread.body),
    ...thread.replies.map((r) => el('div', { class: 'rv-reply' }, message(r.author, r.createdAt, r.body))),
    thread.state === 'resolved'
      ? el(
          'div',
          { class: 'rv-muted' },
          `Resolved by ${thread.resolvedBy ?? ''}${thread.resolvedPr ? ` in PR #${thread.resolvedPr}` : ''}`,
        )
      : null,
    // Old versions are for the team only; a reader would get a refusal.
    thread.outdated && me.role !== 'reader'
      ? el('button', { class: 'rv-link', onclick: () => actions.viewOld(thread) }, 'See the text it was about')
      : null,
    el(
      'div',
      { class: 'rv-actions' },
      thread.state === 'open' ? replyBox : null,
      thread.state === 'open'
        ? el('button', { class: 'rv-btn', onclick: () => actions.reply(thread, replyBox.value) }, 'Reply')
        : null,
      settle && thread.state === 'open'
        ? el('button', { class: 'rv-btn', onclick: () => actions.resolve(thread) }, 'Resolve')
        : null,
      settle && thread.state === 'resolved'
        ? el('button', { class: 'rv-btn', onclick: () => actions.reopen(thread) }, 'Reopen')
        : null,
    ),
  );
};

export const commentsBlock = (sections: Section[], threads: Thread[], me: Me, actions: ThreadActions) => {
  const title = (id: string) => sections.find((s) => s.id === id)?.title || 'Top of the page';
  const live = threads.filter((t) => !t.outdated);
  const outdated = threads.filter((t) => t.outdated);
  const groups = Map.groupBy(live, (t) => t.heading);
  return el(
    'section',
    { class: 'rv-comments', id: 'rv-comments' },
    el('h2', {}, 'Comments'),
    threads.length === 0
      ? el('p', { class: 'rv-muted' }, 'No comments yet. Select any text on the page to comment.')
      : null,
    ...[...groups.entries()].map(([heading, list]) =>
      el(
        'div',
        { class: 'rv-group', id: `rv-group-${heading}` },
        el('h3', {}, title(heading)),
        ...list.map((t) => threadCard(t, me, actions)),
      ),
    ),
    outdated.length
      ? el(
          'details',
          { class: 'rv-outdated' },
          el('summary', {}, `Outdated (${outdated.length})`),
          ...outdated.map((t) => threadCard(t, me, actions)),
        )
      : null,
  );
};

export const commentForm = (quote: string, onPost: (body: string) => void, onCancel: () => void) => {
  const box = el('textarea', { class: 'rv-input', rows: '3', maxlength: '5000', placeholder: 'Your comment' });
  return el(
    'div',
    { class: 'rv-form' },
    el('blockquote', { class: 'rv-quote' }, quote),
    box,
    el(
      'div',
      { class: 'rv-actions' },
      el('button', { class: 'rv-btn', onclick: () => onPost(box.value) }, 'Post'),
      el('button', { class: 'rv-btn rv-ghost', onclick: onCancel }, 'Cancel'),
    ),
  );
};

// ---- status board ----

// A page key back to its address: index is the folder, the rest are clean URLs.
export const hrefOf = (page: string, base: string) => {
  if (page === 'index') return base;
  if (page.endsWith('/index')) return `${base}${page.slice(0, -'index'.length)}`;
  return `${base}${page}`;
};

// Links are under the site's base, /<repo>/.
export const statusBoard = (rows: PageStatus[], base: string) =>
  el(
    'table',
    { class: 'rv-board' },
    el('thead', {}, el('tr', {}, el('th', {}, 'Page'), el('th', {}, 'Status'), el('th', {}, 'Last change'))),
    el(
      'tbody',
      {},
      ...rows
        .sort((a, b) => a.status.localeCompare(b.status) || a.title.localeCompare(b.title))
        .map((r) =>
          el(
            'tr',
            {},
            el('td', {}, el('a', { href: hrefOf(r.page, base) }, r.title)),
            el('td', {}, STATUS_TEXT[r.status], r.wasReadyAt ? ' (was ready, changed since)' : ''),
            el('td', {}, r.changedAt ? `${when(r.changedAt)}, ${r.changedBy ?? ''}` : ''),
          ),
        ),
    ),
  );
