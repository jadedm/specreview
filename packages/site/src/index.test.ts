import { expect, it } from 'vitest';
import { SITE_PACKAGE } from './index';

it('exports its package name', () => {
  expect(SITE_PACKAGE).toBe('@specreview/site');
});
