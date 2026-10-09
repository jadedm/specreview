import { describe, expect, it } from 'vitest';
import type { Site } from '../src/config';
import { roleOf } from '../src/roles';

const site: Site = {
  repo: 'sidecar',
  key: 'acme/sidecar',
  teamDomains: ['acme.dev'],
  approvers: ['approver@acme.dev'],
  readers: ['@initech.example', 'pm@partner.example'],
  ticketRepo: 'acme/sidecar',
  teamLabel: 'acme team',
  branch: 'main',
  repositoryId: '1',
  workflow: '.github/workflows/docs.yml',
  environment: null,
};
const other: Site = {
  ...site,
  repo: 'globex',
  key: 'acme/globex',
  teamDomains: ['globex.dev'],
  approvers: ['pm@globex.dev'],
  readers: [],
};

describe('35: roles', () => {
  it('matches the domain exactly', () => {
    expect(roleOf('x@acme.dev.evil.com', site)).toBe('none');
    expect(roleOf('x@evil-acme.dev', site)).toBe('none');
    expect(roleOf('x@sub.acme.dev', site)).toBe('none');
    expect(roleOf('x@acme.dev', site)).toBe('team');
    expect(roleOf('x@\u0430cme.dev', site)).toBe('none'); // Cyrillic а in the team's domain
    expect(roleOf('approver@acme.dev', site)).toBe('approver');
  });

  it('M3, M4: team and approver are per site', () => {
    expect(roleOf('x@acme.dev', other)).toBe('none');
    expect(roleOf('x@globex.dev', other)).toBe('team');
    expect(roleOf('approver@acme.dev', other)).toBe('none');
    expect(roleOf('pm@globex.dev', site)).toBe('none');
  });

  it('5, 6: readers by exact email or @domain, nobody else', () => {
    expect(roleOf('riya@initech.example', site)).toBe('reader');
    expect(roleOf('pm@partner.example', site)).toBe('reader');
    expect(roleOf('other@partner.example', site)).toBe('none');
    expect(roleOf('riya@sub.initech.example', site)).toBe('none');
    expect(roleOf('riya@initech.example', other)).toBe('none');
    expect(roleOf('not-an-email', site)).toBe('none');
  });
});
