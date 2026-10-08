import type { HistoryEntry, Status } from '@specreview/shared';
import type { Router } from 'vitepress';
import { type Api, apiFor, ApiError, type Me, type PageData, type Pages, type Thread } from './api';
import { el } from './dom';
import { commentForm, commentsBlock, statusBar, statusBoard, ticketBox } from './render';
import { diffView, historyList, oldVersionView } from './render-history';
import { sectionOfSelection } from './selection';

export const TOP_MOUNT = 'rv-mount-top';
export const BOTTOM_MOUNT = 'rv-mount-bottom';
const TOP_ID = 'rv-top';
const BOTTOM_ID = 'rv-bottom';

// The page key the hub and the build use: the path under the site's base,
// without .html and outer slashes; the site root is "index". A folder's
// index.md is served at /<repo>/folder/ and keyed folder/index, which the
// caller resolves against the page list (keyIn).
export const pageKeyOf = (routePath: string, base: string) => {
  const path = decodeURIComponent(routePath);
  if (`${path}/` === base) return 'index';
  const under = path.startsWith(base) ? path.slice(base.length) : path.replace(/^\/+/, '');
  const clean = under.replace(/\.html$/, '').replace(/^\/+|\/+$/g, '');
  if (clean === '') return 'index';
  // A trailing slash is the folder's own page, as the hub serves it.
  return under.endsWith('/') ? `${clean}/index` : clean;
};

// /folder names folder.md when there is one, else folder/index (the hub's
// order); /folder/ is always folder/index (pageKeyOf).
export const keyIn = (pages: Pages['pages'], key: string): string | null => {
  if (Object.hasOwn(pages, key)) return key;
  if (Object.hasOwn(pages, `${key}/index`)) return `${key}/index`;
  return null;
};

const content = () => document.querySelector<HTMLElement>('.vp-doc > div');

const notice = (text: string) => el('div', { class: 'rv-banner rv-error', role: 'alert' }, text);

export const explain = (err: unknown) => {
  if (err instanceof ApiError && err.status === 401)
    return 'Your sign-in has expired. Reload the page to sign in again.';
  if (err instanceof ApiError && err.message) return err.message;
  return 'Something went wrong. Reload and try again.';
};

// Each piece of the UI replaces its previous copy inside our own mount.
const place = (id: string, node: Node, where: 'top' | 'bottom') => {
  const mount = document.getElementById(where === 'top' ? TOP_MOUNT : BOTTOM_MOUNT);
  if (!mount) return;
  document.getElementById(id)?.remove();
  const wrapper = el('div', { id }, node);
  if (where === 'top') mount.prepend(wrapper);
  else mount.append(wrapper);
};

const clearMounts = () => {
  for (const id of [TOP_MOUNT, BOTTOM_MOUNT]) document.getElementById(id)?.replaceChildren();
};

const showError = (err: unknown) => place(TOP_ID + '-error', notice(explain(err)), 'top');

// Cancel means do not resolve; an empty answer means no PR.
const askPr = (): { cancelled: true } | { cancelled: false; pr?: number } => {
  const answer = window.prompt('PR number that resolved this (leave empty if none)', '');
  if (answer === null) return { cancelled: true };
  const n = Number(answer);
  return { cancelled: false, pr: Number.isInteger(n) && n > 0 ? n : undefined };
};

export const createReview = (api: Api, base: string) => {
  let pages: Pages | null = null;
  let me: Me | null = null;
  // Each load gets a number; a slower earlier load that finishes after the
  // reader has moved on is dropped instead of drawing onto the new page.
  let currentLoad = 0;
  // The page the reader is on. A write that finishes after they moved on
  // refreshes nothing, instead of drawing the old page over the new one.
  let activeKey = '';

  const showOld = async (h: HistoryEntry | null) => {
    if (!h) return showError(new ApiError(404, 'NO_VERSION', "That version is not in this page's history."));
    const markdown = await api.oldVersion(h.commit, h.path).catch((e: unknown) => {
      showError(e);
      return null;
    });
    if (markdown === null) return;
    const view = oldVersionView(h, markdown, () => document.getElementById('rv-old')?.remove());
    place('rv-old', view, 'top');
    window.scrollTo({ top: 0 });
  };

  const showDiff = async (history: HistoryEntry[], h: HistoryEntry) => {
    const latest = history[0];
    const [older, newer] = await Promise.all([
      api.oldVersion(h.commit, h.path),
      api.oldVersion(latest.commit, latest.path),
    ]).catch((e: unknown) => {
      showError(e);
      return [null, null];
    });
    if (older === null || newer === null) return;
    place(
      'rv-old',
      diffView(older, newer, () => document.getElementById('rv-old')?.remove()),
      'top',
    );
    window.scrollTo({ top: 0 });
  };

  const render = async (routeKey: string) => {
    const load = ++currentLoad;
    const stale = () => load !== currentLoad;
    clearMounts();
    forgetSelection();
    pages ??= await api.pages();
    me ??= await api.me();
    const page = keyIn(pages.pages, routeKey);
    if (!page) return;
    const entry: PageData = pages.pages[page];
    const [threads, statuses, tickets] = await Promise.all([api.comments(page), api.statuses(), api.tickets(page)]);
    if (stale()) return;
    const status = statuses.find((s) => s.page === page);
    if (!status) return;
    const openLive = threads.filter((t) => t.state === 'open').length;
    const refresh = () => (keyIn(pages?.pages ?? {}, activeKey) === page ? render(page).catch(showError) : undefined);
    const act = (work: Promise<unknown>) => work.then(refresh, showError);
    const history = entry.history;

    const setStatus = (target: Status) =>
      act(api.setStatus({ page, status: target, expectedVersion: status.version, hash: entry.hash }));
    const actions = {
      reply: (t: Thread, body: string) => act(api.reply(t.id, body)),
      resolve: (t: Thread) => {
        const answer = askPr();
        if (!answer.cancelled) act(api.resolve(t.id, answer.pr));
      },
      reopen: (t: Thread) => act(api.reopen(t.id)),
      viewOld: (t: Thread) => showOld(history?.find((h) => h.hash === t.pageHash) ?? null),
    };
    place(
      TOP_ID,
      el(
        'div',
        { class: 'rv-top' },
        statusBar(status, me, openLive, { set: setStatus }),
        ticketBox(tickets),
        // History is the team's; a reader's page data has none.
        history
          ? historyList(history, me, {
              view: (h) => showOld(h),
              diff: (h) => showDiff(history, h),
            })
          : null,
      ),
      'top',
    );
    place(BOTTOM_ID, commentsBlock(entry.sections, threads, me, actions), 'bottom');
    // The index also shows every page's status, under its own comments.
    if (page === 'index') place('rv-board', statusBoard(statuses, base), 'bottom');
    watchSelection(page, refresh);
  };

  // One floating "Comment" button, shown over a selection inside the page text.
  let selectionHandler: ((e: MouseEvent) => void) | null = null;
  // On every page change: no button or handler from the last page survives.
  function forgetSelection() {
    document.querySelector('.rv-pop')?.remove();
    if (selectionHandler) document.removeEventListener('mouseup', selectionHandler);
    selectionHandler = null;
  }

  const watchSelection = (page: string, refresh: () => void) => {
    if (selectionHandler) document.removeEventListener('mouseup', selectionHandler);
    selectionHandler = (event) => {
      if ((event.target as HTMLElement | null)?.closest('.rv-top, .rv-comments, .rv-pop, .rv-form, .rv-old')) return;
      document.querySelector('.rv-pop')?.remove();
      const root = content();
      const picked = root ? sectionOfSelection(root, window.getSelection()) : null;
      if (!picked) return;
      const pop = el(
        'button',
        {
          class: 'rv-pop',
          style: `top:${picked.rect.bottom + window.scrollY + 6}px;left:${picked.rect.left + window.scrollX}px`,
          onclick: () => {
            pop.remove();
            const form = commentForm(
              picked.quote,
              (body) =>
                api.comment({ page, heading: picked.section, quote: picked.quote, body }).then(refresh, showError),
              () => form.remove(),
            );
            place('rv-form', form, 'bottom');
            form.scrollIntoView({ behavior: 'smooth', block: 'center' });
          },
        },
        'Comment',
      );
      document.body.append(pop);
    };
    document.addEventListener('mouseup', selectionHandler);
  };

  return {
    render: (routeKey: string) => {
      activeKey = routeKey;
      return render(routeKey).catch(showError);
    },
  };
};

// The page is read from the address the router reports loading. router.route.path
// still says "/" when the first page finishes loading, which would show (and post
// comments to) the home page while another page is on screen.
export const pathOf = (to: string, origin: string) => new URL(to, origin).pathname;

// onAfterPageLoad also fires for the first page, so it is the only trigger.
export const startReview = (router: Router, base: string) => {
  const review = createReview(apiFor(base), base);
  router.onAfterPageLoad = (to: string) => review.render(pageKeyOf(pathOf(to, location.origin), base));
};
