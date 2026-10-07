import { expect, it } from 'vitest';
import { ACTION_PACKAGE } from './index';

it('exports its package name', () => {
  expect(ACTION_PACKAGE).toBe('@specreview/action');
});
