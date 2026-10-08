import { describe, expect, it } from 'vitest';
import type { Site } from '../src/config';
import { roleOf } from '../src/roles';

const site: Site = {
  repo: 'sidecar',
  key: 'inoltrotech/sidecar',
  teamDomains: ['inoltro.ai'],
  approvers: ['approver@inoltro.ai'],
  readers: ['@ariai.example', 'pm@partner.example'],
  ticketRepo: 'inoltrotech/sidecar',
};
const other: Site = {
  ...site,
  repo: 'tikiti',
  key: 'inoltrotech/tikiti',
  teamDomains: ['tikiti.live'],
  approvers: ['pm@tikiti.live'],
  readers: [],
};

describe('35: roles', () => {
  it('matches the domain exactly', () => {
    expect(roleOf('x@inoltro.ai.evil.com', site)).toBe('none');
    expect(roleOf('x@evil-inoltro.ai', site)).toBe('none');
    expect(roleOf('x@sub.inoltro.ai', site)).toBe('none');
    expect(roleOf('x@inoltro.ai', site)).toBe('team');
    expect(roleOf('x@іnoltro.ai', site)).toBe('none'); // Cyrillic і
    expect(roleOf('approver@inoltro.ai', site)).toBe('approver');
  });

  it('M3, M4: team and approver are per site', () => {
    expect(roleOf('x@inoltro.ai', other)).toBe('none');
    expect(roleOf('x@tikiti.live', other)).toBe('team');
    expect(roleOf('approver@inoltro.ai', other)).toBe('none');
    expect(roleOf('pm@tikiti.live', site)).toBe('none');
  });

  it('5, 6: readers by exact email or @domain, nobody else', () => {
    expect(roleOf('riya@ariai.example', site)).toBe('reader');
    expect(roleOf('pm@partner.example', site)).toBe('reader');
    expect(roleOf('other@partner.example', site)).toBe('none');
    expect(roleOf('riya@sub.ariai.example', site)).toBe('none');
    expect(roleOf('riya@ariai.example', other)).toBe('none');
    expect(roleOf('not-an-email', site)).toBe('none');
  });
});
