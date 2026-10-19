import { b64, caller, CONFIG_FILE, unb64 } from './add-site';
import { redirectOf } from './github-fetch';
import { problemsIn, type HubConfig } from './config';
import type { Env } from './env';
import type { GitHubAuth } from './github-auth';
import { addPending, clearPendingAt, pendingAt, type List } from './pending';
import { roleOf, type Role } from './roles';

// Longer than any commit takes to land; see the add that finds the entry already listed.
const IN_FLIGHT_MS = 2 * 60_000;

// Editing a site's readers and approvers from the admin page (#12, option A):
// the lists live only in the config file in the config repo, so each change
// is one commit there by the organisation's app, requested by the admin. The
// config repo's apply workflow carries it to Cloudflare's login and the hub.
// A removal also takes effect at once through pending_removals.

export type AccessChange = {
  site: string;
  list: List;
  action: 'add' | 'remove' | 'restore';
  entry: string;
  // restore only: the time of the removal the admin saw.
  removedAt?: number;
};
export type Outcome =
  // refused: a removal refuses them here now ('unknown' when the
  // hub could not check), so the result must not say they are let in.
  | { kind: 'done'; still?: string; keeps?: Role; note?: string; refused?: true | 'unknown' }
  | { kind: 'unchanged'; why: string }
  | { kind: 'refused'; status: number; why: string }
  // A removal the hub enforces but could not commit: it stands until an
  // admin lets the person back in.
  | { kind: 'standing'; why: string }
  | { kind: 'restored' };

type ConfigFile = { sha: string; branch: string; config: Record<string, unknown> };
type SiteEntry = { repo?: unknown; readers?: unknown; approvers?: unknown; team?: unknown } & Record<string, unknown>;

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

// The config file as committed on the config repo's default branch.
export const readConfig = async (auth: GitHubAuth, configRepo: string): Promise<ConfigFile | null> => {
  const call = caller(auth);
  const info = await call(configRepo, 'setup-config', 'GET', '').catch(() => null);
  if (!info?.ok) return null;
  const { default_branch: branch } = (await info.json()) as { default_branch: string };
  const file = await call(
    configRepo,
    'setup-config',
    'GET',
    `/contents/${CONFIG_FILE}?ref=${encodeURIComponent(branch)}`,
  ).catch(() => null);
  if (!file?.ok) return null;
  const { sha, content } = (await file.json()) as { sha: string; content: string };
  try {
    return { sha, branch, config: JSON.parse(unb64(content)) as Record<string, unknown> };
  } catch {
    return null;
  }
};

export const listsIn = (config: Record<string, unknown>, repo: string) => {
  const site = (Array.isArray(config.sites) ? config.sites : []).find((s) => (s as SiteEntry).repo === repo) as
    SiteEntry | undefined;
  return site ? { readers: strings(site.readers), approvers: strings(site.approvers), team: strings(site.team) } : null;
};

// The change applied to a copy, or why it changes nothing.
const applied = (config: Record<string, unknown>, change: AccessChange) => {
  const sites = (Array.isArray(config.sites) ? config.sites : []) as SiteEntry[];
  const at = sites.findIndex((s) => s.repo === change.site);
  if (at < 0) return { why: `${change.site} is not in the config file` };
  const list = strings(sites[at][change.list]);
  const has = list.includes(change.entry);
  if (change.action === 'add' && has) return { why: `${change.entry} is already listed` };
  if (change.action === 'remove' && !has) return { why: `${change.entry} is not listed` };
  const next = change.action === 'add' ? [...list, change.entry] : list.filter((e) => e !== change.entry);
  const copy = sites.slice();
  copy[at] = { ...sites[at], [change.list]: next };
  const updated: Record<string, unknown> = { ...config, sites: copy };
  return { config: updated };
};

const word = { readers: 'reader', approvers: 'approver', team: 'team member' };
const messageOf = (change: AccessChange, email: string) =>
  `chore(config): ${change.action} ${word[change.list]} ${change.entry} ${change.action === 'add' ? 'to' : 'from'} ${change.site}\n\nRequested by ${email} on the hub's admin page.`;

// What still covers someone after their exact entry is removed: an @domain
// in the same list, or for a team member one of the site's team domains.
const stillReads = (config: Record<string, unknown>, change: AccessChange) => {
  if (change.entry.startsWith('@')) return undefined;
  const domain = change.entry.split('@')[1];
  if (change.list === 'team') return teamDomainsIn(config, change.site).includes(domain) ? domain : undefined;
  return listsIn(config, change.site)?.[change.list].includes(`@${domain}`) ? `@${domain}` : undefined;
};
// Their role on the site under the changed config, every list counted.
const roleAfter = (config: Record<string, unknown>, change: AccessChange): Role => {
  const lists = listsIn(config, change.site);
  if (!lists) return 'none';
  const site = { ...lists, teamDomains: teamDomainsIn(config, change.site) } as unknown as Parameters<typeof roleOf>[1];
  return roleOf(change.entry, site);
};
const teamDomainsIn = (config: Record<string, unknown>, repo: string) => {
  const site = (Array.isArray(config.sites) ? config.sites : []).find((s) => (s as SiteEntry).repo === repo) as
    SiteEntry | undefined;
  return strings(site?.teamDomains);
};

// Pending removals fail closed: a removal is recorded before anything else
// and is only ever cleared by an admin (adding the entry back, or letting the
// person back in), never by guessing from what GitHub seems to say, and never
// a removal made after the admin's action began (#67).
export const changeAccess = async (
  change: AccessChange,
  ctx: { config: HubConfig; env: Env; auth: GitHubAuth; email: string },
): Promise<Outcome> => {
  const { config, env, auth, email } = ctx;
  const site = config.sites.get(change.site);
  if (!site) return { kind: 'refused', status: 400, why: 'that site is not on the hub' };
  if (change.action === 'restore') {
    if (change.removedAt === undefined) return { kind: 'refused', status: 400, why: 'the removal to clear is missing' };
    const cleared = await clearPendingAt(env, site.key, change.list, change.entry, change.removedAt);
    if (!cleared)
      return {
        kind: 'unchanged',
        why: `the removal of ${change.entry} changed since the page was loaded; reload the admin page`,
      };
    return { kind: 'restored' };
  }
  // The removal this add may clear, as it stands now; one made after this is
  // never cleared by it.
  const seen = change.action === 'add' ? await pendingAt(env, site.key, change.list, change.entry) : undefined;
  const clearSeen = (olderThan = Infinity) =>
    typeof seen === 'number' && seen < olderThan
      ? clearPendingAt(env, site.key, change.list, change.entry, seen).catch(() => false)
      : Promise.resolve(false);
  // After clearing, read again: whether a removal refuses them here now, so
  // the result reports what another admin did meanwhile too (#69).
  const refusalNow = async (): Promise<true | 'unknown' | undefined> => {
    const now = await pendingAt(env, site.key, change.list, change.entry);
    return now === null ? 'unknown' : now === undefined ? undefined : true;
  };
  const configRepo = config.configRepo;
  if (!configRepo) return { kind: 'refused', status: 409, why: 'the hub does not know its config repo' };
  if (!(await auth.hasApp?.())) return { kind: 'refused', status: 409, why: 'the hub has no GitHub App' };
  const removing = change.action === 'remove';
  const live = site[change.list].includes(change.entry);
  // Takes effect at once, whatever happens to the commit, and whatever this
  // isolate's possibly older config says.
  if (removing) await addPending(env, site.key, change.list, change.entry, email);
  const call = caller(auth);
  const failed = (status: number, why: string): Outcome =>
    removing ? { kind: 'standing', why } : { kind: 'refused', status, why };

  const attempt = async (): Promise<Outcome | 'conflict'> => {
    const file = await readConfig(auth, configRepo);
    if (!file) return failed(502, `the hub could not read ${CONFIG_FILE} from ${configRepo}`);
    const lists = listsIn(file.config, change.site);
    if (!lists) return failed(409, `${change.site} is not in ${CONFIG_FILE}`);
    const has = lists[change.list].includes(change.entry);
    if (!removing && has) {
      // Already in git: an old removal no longer should keep them out.
      await clearSeen(Date.now() - IN_FLIGHT_MS);
      const refused = await refusalNow();
      const why = {
        yes: `${change.entry} is already listed, but a removal still refuses them here; the admin page offers Let back in`,
        unknown: `${change.entry} is already listed; the hub could not check for a removal, so reload the admin page to see whether one still refuses them`,
        no: `${change.entry} is already listed; the hub lets them in`,
      }[refused === true ? 'yes' : (refused ?? 'no')];
      return { kind: 'unchanged', why };
    }
    if (removing && !has)
      return live
        ? { kind: 'done', note: 'It was already removed in git, not yet deployed; the hub refuses them from now.' }
        : { kind: 'unchanged', why: `${change.entry} is not listed` };
    const next = applied(file.config, change);
    if (!next.config) return failed(409, next.why ?? 'nothing to change');
    const { brand: _brand, ...checked } = next.config as Record<string, unknown>;
    const problems = problemsIn({ ...checked, accessTeamDomain: config.accessTeamDomain, accessAud: config.accessAud });
    if (problems.length > 0)
      return removing
        ? failed(400, `the config file has other problems, so the commit was not made: ${problems.join('; ')}`)
        : { kind: 'refused', status: 400, why: problems.join('; ') };
    const res = await call(configRepo, 'setup-config', 'PUT', `/contents/${CONFIG_FILE}`, {
      message: messageOf(change, email),
      content: b64(`${JSON.stringify(next.config, null, 2)}\n`),
      branch: file.branch,
      sha: file.sha,
      author: { name: email, email },
    }).catch(() => null);
    if (res?.status === 200 || res?.status === 201) {
      if (!removing) await clearSeen();
      const refused = removing ? undefined : await refusalNow();
      const still = stillReads(next.config, change);
      // Covered some other way (another list, a team domain): say what is left.
      const left = removing && !still && !change.entry.startsWith('@') ? roleAfter(next.config, change) : 'none';
      return { kind: 'done', still, ...(left !== 'none' && { keeps: left }), ...(refused && { refused }) };
    }
    if (res?.status === 409) return 'conflict';
    if (!res) return failed(502, 'GitHub gave no answer; the commit may or may not have landed, check the history');
    const hint = res.status === 422 || res.status === 403 ? '; the default branch may be protected' : '';
    const redirect = redirectOf(res);
    return failed(502, `GitHub did not take the commit (${redirect ? `a redirect, ${redirect}` : res.status})${hint}`);
  };

  const first = await attempt();
  if (first !== 'conflict') return first;
  // Someone changed the file meanwhile: once more on the fresh file.
  const second = await attempt();
  if (second !== 'conflict') return second;
  return failed(409, 'the config file kept changing; try again');
};
