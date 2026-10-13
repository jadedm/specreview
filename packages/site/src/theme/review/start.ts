import type { HistoryEntry, Status } from '@specreview/shared';
import type { Router } from 'vitepress';
import { type Api, apiFor, ApiError, type Me, NETWORK, type PageData, type Pages, type Thread } from './api';
import { el } from './dom';
import { commentForm, commentsBlock, statusBar, statusBoard, ticketBox } from './render';
import { diffView, historyList, oldVersionView } from './render-history';
import { sectionOfSelection } from './selection';
import { announceLoading, bottomSkeleton, topSkeleton } from './skeleton';

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

export const SIGNED_OUT_TEXT = 'Your sign-in has expired. Reload the page to sign in again.';
export const NETWORK_TEXT = 'Could not reach the hub. Check your connection, then reload the page.';
export const MAY_HAVE_SAVED = 'Your change may have been saved. Reload the page to check.';
export const NO_ACCESS_TEXT = "Your account cannot read this site. Ask the site's team for access.";

// The reference rides along on server errors: those are the ones worth
// finding in Cloudflare's logs.
const withReference = (text: string, err: ApiError) =>
  err.reference ? `${text.replace(/\.$/, '')} (${err.reference}).` : text;

export const explain = (err: unknown) => {
  if (!(err instanceof ApiError)) return 'Something went wrong. Reload and try again.';
  if (err.status === 401) return SIGNED_OUT_TEXT;
  if (err.code === NETWORK) return NETWORK_TEXT;
  // Access refusing by policy answers with its own page, not the hub's JSON.
  if (err.status === 403 && !err.message) return NO_ACCESS_TEXT;
  if (err.message && err.status >= 500) return withReference(err.message, err);
  if (err.message) return err.message;
  if (err.reference) return `Something went wrong (${err.reference}). Reload and try again.`;
  return 'Something went wrong. Reload and try again.';
};

// A write the hub may have saved: no answer at all, or a server error, which
// can come after the database write (a crash, a timeout at the edge).
const outcomeUnknown = (err: unknown) => err instanceof ApiError && (err.code === NETWORK || err.status >= 500);

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

const mounts = () =>
  [TOP_MOUNT, BOTTOM_MOUNT].map((id) => document.getElementById(id)).filter((m): m is HTMLElement => m !== null);

// The panels stop being busy. Every way a write or a load ends goes through
// here; the mounts are ours, so nothing else would take the attribute off.
const unbusy = () => {
  for (const m of mounts()) m.removeAttribute('aria-busy');
};

// The top mount reserves the placeholder's height in CSS before any script
// runs. Once a load knows there is no panel (no review data, or an error),
// the reservation goes, so no blank gap is left above the page.
export const UNRESERVED = 'rv-unreserved';
const reserve = (on: boolean) => document.getElementById(TOP_MOUNT)?.classList.toggle(UNRESERVED, !on);

const showError = (err: unknown) => place(TOP_ID + '-error', notice(explain(err)), 'top');

export const SAVED_NOT_RELOADED = 'Saved, but the comments could not be reloaded. Reload the page.';
export const NO_STATUS =
  'This page has no review status. Reload the page; if it stays, the docs may need publishing again.';

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
  // The page the reader is on.
  let activeKey = '';
  // Counts page visits. A write or a history fetch belongs to the visit that
  // started it: once the reader has opened a page since, even the same page
  // again, its result draws nothing.
  let visit = 0;

  const showOld = async (h: HistoryEntry | null) => {
    if (!h) return showError(new ApiError(404, 'NO_VERSION', "That version is not in this page's history."));
    const mine = visit;
    const markdown = await api.oldVersion(h.commit, h.path).catch((e: unknown) => {
      if (visit === mine) showError(e);
      return null;
    });
    if (markdown === null || visit !== mine) return;
    const view = oldVersionView(h, markdown, () => document.getElementById('rv-old')?.remove());
    place('rv-old', view, 'top');
    window.scrollTo({ top: 0 });
  };

  const showDiff = async (history: HistoryEntry[], h: HistoryEntry) => {
    const latest = history[0];
    const mine = visit;
    const [older, newer] = await Promise.all([
      api.oldVersion(h.commit, h.path),
      api.oldVersion(latest.commit, latest.path),
    ]).catch((e: unknown) => {
      if (visit === mine) showError(e);
      return [null, null];
    });
    if (older === null || newer === null || visit !== mine) return;
    place(
      'rv-old',
      diffView(older, newer, () => document.getElementById('rv-old')?.remove()),
      'top',
    );
    window.scrollTo({ top: 0 });
  };

  // While a write runs, every write control on the panel is disabled, the
  // panels are busy, and the button that started it shows its busy label.
  // Reading controls (history, old text) stay usable. On failure, release()
  // puts each control back exactly as it was: a "Mark ready" blocked by open
  // comments stays blocked. On success the redraw replaces them all.
  let holding = false;
  // The pending "Loading comments and status" announcement, if any.
  let announcing: ReturnType<typeof setTimeout> | undefined;
  const writeControls = () =>
    mounts().flatMap((m) => [
      ...m.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>('button[data-write], textarea'),
    ]);
  const hold = (button: HTMLButtonElement) => {
    const controls = writeControls();
    const before = controls.map((c) => c.disabled);
    const label = button.textContent;
    for (const c of controls) c.disabled = true;
    for (const m of mounts()) m.setAttribute('aria-busy', 'true');
    // A Comment button already showing would open a form that cannot post.
    document.querySelector('.rv-pop')?.remove();
    button.textContent = button.dataset.busy ?? 'Saving';
    button.setAttribute('aria-busy', 'true');
    return () => {
      controls.forEach((c, i) => (c.disabled = before[i]));
      unbusy();
      button.textContent = label;
      button.removeAttribute('aria-busy');
    };
  };

  // One write at a time; a second click while one runs does nothing. Its
  // result belongs to the visit that started it: once the reader has opened
  // a page since, nothing is drawn and the hold is the new visit's to manage.
  // A write that saved but whose redraw failed keeps every write control
  // disabled, since the old panel would invite a duplicate comment or a
  // status change against an old version.
  const act = (button: HTMLButtonElement, write: () => Promise<unknown>) => {
    if (holding) return;
    holding = true;
    const origin = activeKey;
    const mine = visit;
    const here = () => visit === mine;
    const release = hold(button);
    write().then(
      () => {
        if (!here()) return;
        return render(origin, true).then(
          () => {
            if (!here()) return;
            holding = false;
            unbusy();
          },
          () => {
            if (!here()) return;
            release();
            for (const c of writeControls()) c.disabled = true;
            showError(new ApiError(0, 'NOT_RELOADED', SAVED_NOT_RELOADED));
          },
        );
      },
      (err: unknown) => {
        if (!here()) return;
        release();
        // Saved or not is unknown: keep the write controls disabled, as for a
        // write that saved but could not be redrawn, so nothing is posted twice.
        if (outcomeUnknown(err)) {
          for (const c of writeControls()) c.disabled = true;
          const ref = err instanceof ApiError ? err.reference : '';
          return showError(
            new ApiError(
              0,
              'MAY_HAVE_SAVED',
              ref ? MAY_HAVE_SAVED.replace('saved.', `saved (${ref}).`) : MAY_HAVE_SAVED,
            ),
          );
        }
        holding = false;
        showError(err);
      },
    );
  };

  // A load shows placeholders, then the panel. A quiet load (the redraw after
  // a write) fetches first and swaps the panel in one step, so it never
  // blinks. A load the reader has moved on from draws nothing, errors
  // included: the newer load owns the mounts.
  const render = async (routeKey: string, quiet = false) => {
    const load = ++currentLoad;
    const stale = () => load !== currentLoad;
    forgetSelection();
    if (!quiet) {
      visit++;
      holding = false;
      unbusy();
      clearMounts();
      reserve(true);
      place(TOP_ID, topSkeleton(), 'top');
      place(BOTTOM_ID, bottomSkeleton(), 'bottom');
      clearTimeout(announcing);
      announcing = announceLoading();
    }
    try {
      await draw(routeKey, quiet, stale);
    } catch (err) {
      if (stale()) return;
      if (!quiet) {
        clearMounts();
        reserve(false);
      }
      throw err;
    } finally {
      // The placeholder is gone (or a newer load owns it and set its own timer).
      if (!stale()) clearTimeout(announcing);
    }
  };

  const draw = async (routeKey: string, quiet: boolean, stale: () => boolean) => {
    pages ??= await api.pages();
    me ??= await api.me();
    if (stale()) return;
    const page = keyIn(pages.pages, routeKey);
    // Not every route is a reviewed page; those show no panel.
    if (!page) {
      clearMounts();
      reserve(false);
      return;
    }
    const entry: PageData = pages.pages[page];
    const [threads, statuses, tickets] = await Promise.all([api.comments(page), api.statuses(), api.tickets(page)]);
    if (stale()) return;
    const status = statuses.find((s) => s.page === page);
    // Listed as a page but with no status: the hub's answers disagree.
    if (!status) throw new ApiError(0, 'NO_STATUS', NO_STATUS);
    const openLive = threads.filter((t) => t.state === 'open').length;
    const history = entry.history;

    const setStatus = (target: Status, button: HTMLButtonElement) =>
      act(button, () => api.setStatus({ page, status: target, expectedVersion: status.version, hash: entry.hash }));
    const actions = {
      reply: (t: Thread, body: string, button: HTMLButtonElement) => act(button, () => api.reply(t.id, body)),
      resolve: (t: Thread, button: HTMLButtonElement) => {
        const answer = askPr();
        if (!answer.cancelled) act(button, () => api.resolve(t.id, answer.pr));
      },
      reopen: (t: Thread, button: HTMLButtonElement) => act(button, () => api.reopen(t.id)),
      viewOld: (t: Thread) => showOld(history?.find((h) => h.hash === t.pageHash) ?? null),
    };
    const top = el(
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
    );
    const bottom = commentsBlock(entry.sections, threads, me, actions);
    if (quiet) clearMounts();
    place(TOP_ID, top, 'top');
    place(BOTTOM_ID, bottom, 'bottom');
    // The index also shows every page's status, under its own comments.
    if (page === 'index') place('rv-board', statusBoard(statuses, base), 'bottom');
    watchSelection(page);
  };

  // One floating "Comment" button, shown over a selection inside the page text.
  let selectionHandler: ((e: MouseEvent) => void) | null = null;
  // On every page change: no button or handler from the last page survives.
  function forgetSelection() {
    document.querySelector('.rv-pop')?.remove();
    if (selectionHandler) document.removeEventListener('mouseup', selectionHandler);
    selectionHandler = null;
  }

  const watchSelection = (page: string) => {
    if (selectionHandler) document.removeEventListener('mouseup', selectionHandler);
    selectionHandler = (event) => {
      // No new comment while a write runs: its Post could not start anyway.
      if (holding) return;
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
              (body, button) =>
                act(button, () => api.comment({ page, heading: picked.section, quote: picked.quote, body })),
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
