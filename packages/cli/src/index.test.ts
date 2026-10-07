import { expect, it } from 'vitest';
import { CLI_PACKAGE } from './index';

it('exports its published name', () => {
  expect(CLI_PACKAGE).toBe('@jadedm/specreview');
});
