// #111: the manifest's optional prototypes list.
import { describe, expect, it } from 'vitest';
import { isManifest } from './manifest.js';

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
