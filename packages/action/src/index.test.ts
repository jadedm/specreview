import { expect, it } from 'vitest';
import { ACTION_PACKAGE } from './index.js';

it('exports its package name', () => {
  expect(ACTION_PACKAGE).toBe('@specreview/action');
});
