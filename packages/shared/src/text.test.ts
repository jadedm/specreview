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

describe('#88: exclude patterns', () => {
  it('takes paths and whole-segment ** wildcards; refuses the rest', async () => {
    const { isExcludePattern } = await import('./text');
    for (const ok of ['product/prototypes', 'drafts/', '*.pdf', '**/*.pdf', 'a/**/b', 'x/**', 'a.b-c_d~e'])
      expect(isExcludePattern(ok), ok).toBe(true);
    for (const bad of [
      '/abs',
      '../x',
      'a/./b',
      'a/../b',
      '.',
      '..',
      'a b',
      ':x',
      'a//b',
      '***',
      'a**b',
      'a/**b',
      '',
      'a\\b',
      'x\ny',
    ])
      expect(isExcludePattern(bad), JSON.stringify(bad)).toBe(false);
    expect(isExcludePattern('a'.repeat(200))).toBe(true);
    expect(isExcludePattern('a'.repeat(201))).toBe(false);
    expect(isExcludePattern('a'.repeat(101), 100)).toBe(false);
  });
});
