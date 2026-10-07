import { describe, expect, it } from 'vitest';
import type { Site } from '../src/config';
import { roleOf } from '../src/roles';

const site: Site = {
  repo: 'acme/sidecar',
  accessAud: 'aud',
  teamDomains: ['acme.dev'],
  approvers: ['approver@acme.dev'],
  ticketRepo: 'acme/sidecar',
};
const other: Site = { ...site, repo: 'globex/backend', teamDomains: ['globex.dev'], approvers: ['pm@globex.dev'] };

describe('35: roles', () => {
  it('matches the domain exactly', () => {
    expect(roleOf('x@acme.dev.evil.com', site)).toBe('reader');
    expect(roleOf('x@evil-acme.dev', site)).toBe('reader');
    expect(roleOf('x@sub.acme.dev', site)).toBe('reader');
    expect(roleOf('x@acme.dev', site)).toBe('team');
    expect(roleOf('x@аcme.dev', site)).toBe('reader'); // Cyrillic і
    expect(roleOf('approver@acme.dev', site)).toBe('approver');
  });

  it('M3, M4: team and approver are per site', () => {
    expect(roleOf('x@acme.dev', other)).toBe('reader');
    expect(roleOf('x@globex.dev', other)).toBe('team');
    expect(roleOf('approver@acme.dev', other)).toBe('reader');
    expect(roleOf('pm@globex.dev', site)).toBe('reader');
  });
});
