import type { Site } from './config';

export type Role = 'reader' | 'team' | 'approver';

const domainOf = (email: string) => email.slice(email.lastIndexOf('@') + 1);

// Per site: an email whose domain is exactly one of the site's team domains is
// team; a listed approver (config guarantees approvers are team) can sign off.
// x@acme.dev.evil.com and x@evil-acme.dev are readers.
export const roleOf = (email: string, site: Site): Role => {
  if (!site.teamDomains.includes(domainOf(email))) return 'reader';
  return site.approvers.includes(email) ? 'approver' : 'team';
};

export const isTeam = (role: Role) => role !== 'reader';
