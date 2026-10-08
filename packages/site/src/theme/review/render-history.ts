import { diffLines } from 'diff';
import MarkdownIt from 'markdown-it';
import type { HistoryEntry } from '@specreview/shared';
import type { Me } from './api';
import { el, when } from './dom';

type HistoryActions = { view: (entry: HistoryEntry) => void; diff: (entry: HistoryEntry) => void };

export const historyList = (entries: HistoryEntry[], me: Me, actions: HistoryActions) =>
  el(
    'details',
    { class: 'rv-history' },
    el('summary', {}, `History (${entries.length})`),
    entries.length === 0 ? el('p', { class: 'rv-muted' }, 'Not committed yet.') : null,
    el(
      'ul',
      {},
      ...entries.map((e, i) =>
        el(
          'li',
          {},
          `${when(e.date)}, ${e.author}, ${e.pr ? `PR #${e.pr}` : e.commit.slice(0, 7)} `,
          me.role !== 'reader' ? el('button', { class: 'rv-link', onclick: () => actions.view(e) }, 'View') : null,
          me.role !== 'reader' && i > 0
            ? el('button', { class: 'rv-link', onclick: () => actions.diff(e) }, 'Diff with latest')
            : null,
        ),
      ),
    ),
  );

// Raw HTML off: old Markdown is shown as text and Markdown only, and
// markdown-it's link check refuses javascript: and similar links.
const oldMarkdown = new MarkdownIt({ html: false, linkify: false });
// markdown-it allows data: images; old versions get http, https, mailto and
// relative links and images only.
oldMarkdown.validateLink = (url) => !/^\s*(javascript|vbscript|file|data):/i.test(url);

export const oldVersionView = (entry: HistoryEntry, markdown: string, onClose: () => void) => {
  // vp-doc gives the old version the same typography as the live page.
  const body = el('div', { class: 'rv-old-body vp-doc' });
  body.innerHTML = oldMarkdown.render(markdown.replace(/^---\n[\s\S]*?\n---\n/, ''));
  return el(
    'div',
    { class: 'rv-old' },
    el(
      'div',
      { class: 'rv-banner' },
      `As of ${when(entry.date)}${entry.pr ? `, PR #${entry.pr}` : ''}. `,
      el('button', { class: 'rv-btn', onclick: onClose }, 'Back to latest'),
    ),
    body,
  );
};

type DiffKind = 'add' | 'del' | 'same';
const DIFF_KIND: Record<DiffKind, { className: string; mark: string }> = {
  add: { className: 'rv-add', mark: '+ ' },
  del: { className: 'rv-del', mark: '- ' },
  same: { className: 'rv-same', mark: '  ' },
};
const kindOf = (part: { added?: boolean; removed?: boolean }): DiffKind => {
  if (part.added) return 'add';
  if (part.removed) return 'del';
  return 'same';
};

export const diffView = (older: string, newer: string, onClose: () => void) =>
  el(
    'div',
    { class: 'rv-old' },
    el('div', { class: 'rv-banner' }, 'Changes ', el('button', { class: 'rv-btn', onclick: onClose }, 'Close')),
    el(
      'pre',
      { class: 'rv-diff' },
      ...diffLines(older, newer).map((part) => {
        const kind = DIFF_KIND[kindOf(part)];
        return el(
          'span',
          { class: kind.className },
          part.value
            .split('\n')
            .filter((line, i, all) => i < all.length - 1 || line !== '')
            .map((line) => `${kind.mark}${line}\n`)
            .join(''),
        );
      }),
    ),
  );
