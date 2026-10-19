import { el } from './dom';

// Placeholders shown while a page's review data loads. They take the ids the
// real panel uses, so the panel replaces them in one step. Shapes are classes
// only: grey bars that say nothing to a screen reader, under one status region
// that does. The region goes in empty and gets its text a moment later
// (announceLoading): screen readers announce a change to a live region, not
// one that arrives already holding its text.

type Width = 'w20' | 'w30' | 'w45' | 'w60' | 'w80';

const bar = (width: Width, tall = false) =>
  el('span', { class: `rv-skel-bar rv-skel-${width}${tall ? ' rv-skel-tall' : ''}`, 'aria-hidden': 'true' });

export const LOADING_TEXT = 'Loading comments and status';

// The status bar (a badge, a line of text, a button) and a ticket list with
// one ticket: the panel most reviewed pages get. A page with no tickets or
// with history differs by a line.
export const topSkeleton = () =>
  el(
    'div',
    { class: 'rv-skel', role: 'status' },
    el('span', { class: 'rv-sr' }),
    el(
      'div',
      { class: 'rv-top' },
      el('div', { class: 'rv-skel-row' }, bar('w20', true), bar('w30'), bar('w20', true)),
      el('div', {}, bar('w20'), bar('w45')),
    ),
  );

// The comments heading and one thread. Hidden from screen readers: the top
// placeholder already says the panel is loading.
export const bottomSkeleton = () =>
  el(
    'section',
    { class: 'rv-comments rv-skel', 'aria-hidden': 'true' },
    el('h2', {}, 'Comments'),
    el('div', { class: 'rv-thread' }, bar('w80'), bar('w60'), bar('w30')),
  );

// Long enough for VoiceOver and NVDA to have the region in their tree before
// its text changes; a page that loads faster never shows the text at all.
export const ANNOUNCE_DELAY_MS = 150;
// The caller cancels it once the placeholder is gone. It also does nothing if
// the document itself has gone by then, as when a test's page is torn down.
export const announceLoading = () =>
  setTimeout(() => {
    if (typeof document === 'undefined') return;
    const region = document.querySelector('.rv-skel[role="status"] .rv-sr');
    if (region) region.textContent = LOADING_TEXT;
  }, ANNOUNCE_DELAY_MS);
