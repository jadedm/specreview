import { describe, expect, it } from 'vitest';
import type { Site } from '../src/config';
import { roleOf } from '../src/roles';

const site: Site = {
  repo: 'inoltrotech/sidecar',
  accessAud: 'aud',
  teamDomains: ['inoltro.ai'],
  approvers: ['approver@inoltro.ai'],
  ticketRepo: 'inoltrotech/sidecar',
};
const other: Site = { ...site, repo: 'tikiti/backend', teamDomains: ['tikiti.live'], approvers: ['pm@tikiti.live'] };

describe('35: roles', () => {
  it('matches the domain exactly', () => {
    expect(roleOf('x@inoltro.ai.evil.com', site)).toBe('reader');
    expect(roleOf('x@evil-inoltro.ai', site)).toBe('reader');
    expect(roleOf('x@sub.inoltro.ai', site)).toBe('reader');
    expect(roleOf('x@inoltro.ai', site)).toBe('team');
    expect(roleOf('x@іnoltro.ai', site)).toBe('reader'); // Cyrillic і
    expect(roleOf('approver@inoltro.ai', site)).toBe('approver');
  });

  it('M3, M4: team and approver are per site', () => {
    expect(roleOf('x@inoltro.ai', other)).toBe('reader');
    expect(roleOf('x@tikiti.live', other)).toBe('team');
    expect(roleOf('approver@inoltro.ai', other)).toBe('reader');
    expect(roleOf('pm@tikiti.live', site)).toBe('reader');
  });
});
