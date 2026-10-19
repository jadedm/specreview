import { domainOfEmail, type Site } from './config';

// What someone may do on one site. 'none' may not even read it.
export type Role = 'none' | 'reader' | 'team' | 'approver';

// Per site, each list matching an exact email or @domain (the part after the
// last @): a listed approver signs off and has the team's view (#91); an
// email at a team domain, or named in `team`, is team; a listed reader reads.
// Approver outranks team, team outranks reader. Everyone else is 'none'.
const listed = (list: string[], email: string, domain: string) => list.includes(email) || list.includes(`@${domain}`);

export const roleOf = (email: string, site: Site): Role => {
  const domain = domainOfEmail(email);
  if (!domain) return 'none';
  if (listed(site.approvers, email, domain)) return 'approver';
  if (site.teamDomains.includes(domain) || site.team.includes(email)) return 'team';
  if (listed(site.readers, email, domain)) return 'reader';
  return 'none';
};

export const isTeam = (role: Role) => role === 'team' || role === 'approver';
export const canRead = (role: Role) => role !== 'none';
