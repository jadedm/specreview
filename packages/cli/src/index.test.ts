import { expect, it } from 'vitest';
import { CLI_PACKAGE } from './index.js';

it('exports its published name', () => {
  expect(CLI_PACKAGE).toBe('@jadedm/specreview');
});
