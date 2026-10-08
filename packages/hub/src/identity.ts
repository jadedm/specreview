import type { Site } from './config';
import { isTeam, roleOf, type Role } from './roles';

export type Caller = { email: string; role: Role };

// A stored email as this caller may see it. The team sees addresses. A reader
// sees "You", the site's team label, or "Reader": never anyone's address, so a
// reader cannot collect who else reviews the site. The label follows the
// current config, so it says what the person is to the site now.
export const shownAs = (site: Site, caller: Caller) => (email: string) => {
  if (isTeam(caller.role)) return email;
  if (email === caller.email) return 'You';
  return isTeam(roleOf(email, site)) ? site.teamLabel : 'Reader';
};
