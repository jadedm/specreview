import { describe, expect, it } from 'vitest';
import { linkOf, sidebarOf, titleOf } from './sidebar.js';

const page = (file: string, title: string, order = Number.POSITIVE_INFINITY) => ({ file, title, order });

describe('6: sidebar from the folder tree', () => {
  it('index first, folders as groups with their index as the link, order then title', () => {
    const items = sidebarOf([
      page('zeta.md', 'Zeta'),
      page('index.md', 'Home'),
      page('alpha.md', 'Alpha'),
      page('first.md', 'Last by name, first by order', 1),
      page('guide/index.md', 'Guide'),
      page('guide/b.md', 'B'),
      page('guide/a.md', 'A'),
      page('guide/deep/x.md', 'X'),
      page('notes/n.md', 'N'),
    ]);
    expect(items).toEqual([
      { text: 'Home', link: '/' },
      { text: 'Last by name, first by order', link: '/first' },
      { text: 'Alpha', link: '/alpha' },
      {
        text: 'Guide',
        link: '/guide/',
        items: [
          { text: 'A', link: '/guide/a' },
          { text: 'B', link: '/guide/b' },
          { text: 'deep', items: [{ text: 'X', link: '/guide/deep/x' }] },
        ],
      },
      { text: 'notes', items: [{ text: 'N', link: '/notes/n' }] },
      { text: 'Zeta', link: '/zeta' },
    ]);
  });

  it('a page and a folder of the same name are both listed', () => {
    const items = sidebarOf([
      page('index.md', 'Home'),
      page('guide.md', 'Guide page'),
      page('guide/index.md', 'Guide'),
    ]);
    expect(items.map((i) => [i.text, i.link])).toEqual([
      ['Home', '/'],
      ['Guide', '/guide/'],
      ['Guide page', '/guide'],
    ]);
  });

  it('ties break by path, so the order is the same every build', () => {
    const a = sidebarOf([page('index.md', 'H'), page('b.md', 'Same'), page('a.md', 'Same')]);
    expect(a.map((i) => i.link)).toEqual(['/', '/a', '/b']);
  });
});

describe('titles and links', () => {
  it('front-matter title, then first heading, then file name', () => {
    expect(titleOf('a.md', '# Heading', { title: 'From front matter' })).toBe('From front matter');
    expect(titleOf('a.md', 'text\n\n# Heading #\n', {})).toBe('Heading');
    expect(titleOf('guide/a-page.md', 'no heading', { title: '  ' })).toBe('a-page');
  });

  it('links are clean URLs; a folder index is the folder', () => {
    expect(linkOf('index.md')).toBe('/');
    expect(linkOf('guide/index.md')).toBe('/guide/');
    expect(linkOf('release-1.2.md')).toBe('/release-1.2');
  });
});
