import { describe, expect, it } from 'vitest';
import { isManifest, normalise, quoteIn } from './index';

describe('text rules', () => {
  it('collapse whitespace the same way for the browser and the hub', () => {
    expect(normalise('  a\n\tb\u00a0 c ')).toBe('a b c');
    expect(quoteIn('a   b', 'x a\nb y')).toBe(true);
    expect(quoteIn('   ', 'anything')).toBe(false);
  });
});

describe('manifest', () => {
  const valid = {
    commit: 'a'.repeat(40),
    builtAt: '2026-10-09T00:00:00.000Z',
    pages: { index: { title: 'Home', hash: 'h', issues: [1], sections: [], history: [] } },
  };
  it('accepts a well-formed manifest and refuses a broken one', () => {
    expect(isManifest(valid)).toBe(true);
    expect(isManifest({ ...valid, commit: 'abc' })).toBe(false);
    expect(isManifest({ ...valid, csp: 'a\nb' })).toBe(false);
  });
});
