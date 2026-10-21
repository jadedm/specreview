// #111: the manifest's optional prototypes list.
import { describe, expect, it } from 'vitest';
import { isManifest, issueParts, MAX_PAGE_ISSUES } from './manifest.js';

const base = { commit: 'a'.repeat(40), builtAt: '2026-10-17T00:00:00.000Z', pages: {} };
const hash = (c: string) => c.repeat(64);

describe('#111: prototypes in the manifest', () => {
  it('is optional, and a sorted list of unique paths with sha256 hashes is accepted', () => {
    expect(isManifest(base)).toBe(true);
    expect(
      isManifest({
        ...base,
        prototypes: [
          { path: 'product/prototypes/a/Main.dc.html', hash: hash('a') },
          { path: 'product/prototypes/a/support.js', hash: hash('b') },
        ],
      }),
    ).toBe(true);
  });

  it('refuses a bad list: not an array, unsorted, duplicate, bad path, bad hash', () => {
    const p = (path: string, h = hash('a')) => ({ path, hash: h });
    for (const prototypes of [
      'x',
      [p('b'), p('a')],
      [p('a'), p('a')],
      [p('a/../b')],
      [p('a b')],
      [p('/a')],
      [p('a', 'A'.repeat(64))],
      [p('a', 'abc')],
      [p('.env')],
      [p('a/.hidden')],
      [p('_api/x.html')],
      [p('_signin')],
      [p('A.html'), p('a.html')],
      [{ path: 'a' }],
      [null],
    ])
      expect(isManifest({ ...base, prototypes }), JSON.stringify(prototypes)).toBe(false);
  });
});

describe('#90: ticket links in the manifest', () => {
  const page = (issues: unknown[]) => ({
    ...base,
    pages: { a: { title: 'A', hash: 'h', issues, sections: [], history: [] } },
  });

  it('7: numbers and <repo>#<number>, each once, are accepted; anything else refused', () => {
    expect(isManifest(page([3, 'backend#4']))).toBe(true);
    for (const issues of [['backend#0'], ['Backend#4'], [3, 3], ['backend#4', 'backend#4'], [{}], ['x']])
      expect(isManifest(page(issues)), JSON.stringify(issues)).toBe(false);
  });

  it('#176: a page may link at most 20 tickets', () => {
    expect(MAX_PAGE_ISSUES).toBe(20);
    const links = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
    expect(isManifest(page(links(20)))).toBe(true);
    expect(isManifest(page(links(21)))).toBe(false);
    // A manifest stored before the limit is read with none.
    expect(isManifest(page(links(21)), Number.POSITIVE_INFINITY)).toBe(true);
    expect(isManifest(page([3, 3]), Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('issueParts reads both forms', () => {
    expect(issueParts(3)).toEqual({ repo: null, number: 3 });
    expect(issueParts('backend#4')).toEqual({ repo: 'backend', number: 4 });
    expect(issueParts('.#4')).toBeNull();
  });
});
