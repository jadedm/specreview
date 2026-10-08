import { domainOfEmail, type Site } from './config';

// What someone may do on one site. 'none' may not even read it.
export type Role = 'none' | 'reader' | 'team' | 'approver';

// Per site: an email whose domain is exactly one of the site's team domains
// is team; a listed approver (config guarantees approvers are team) signs off;
// a listed reader (exact email, or @domain equal to the part after the last @)
// reads. Team and approver outrank reader. Everyone else is 'none'.
export const roleOf = (email: string, site: Site): Role => {
  const domain = domainOfEmail(email);
  if (!domain) return 'none';
  if (site.teamDomains.includes(domain)) return site.approvers.includes(email) ? 'approver' : 'team';
  if (site.readers.includes(email) || site.readers.includes(`@${domain}`)) return 'reader';
  return 'none';
};

export const isTeam = (role: Role) => role === 'team' || role === 'approver';
export const canRead = (role: Role) => role !== 'none';
