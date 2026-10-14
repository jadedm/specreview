import { b64, caller, CONFIG_FILE, unb64 } from './add-site';
import { problemsIn, type HubConfig } from './config';
import type { Env } from './env';
import type { GitHubAuth } from './github-auth';
import { addPending, clearPending, clearPendingOlderThan, type List } from './pending';

// Longer than any commit takes to land; see clearPendingOlderThan.
const IN_FLIGHT_MS = 2 * 60_000;

// Editing a site's readers and approvers from the admin page (#12, option A):
// the lists live only in the config file in the config repo, so each change
// is one commit there by the organisation's app, requested by the admin. The
// config repo's apply workflow carries it to Cloudflare's login and the hub.
// A removal also takes effect at once through pending_removals.

export type AccessChange = { site: string; list: List; action: 'add' | 'remove' | 'restore'; entry: string };
export type Outcome =
  | { kind: 'done'; still?: string; note?: string }
  | { kind: 'unchanged'; why: string }
  | { kind: 'refused'; status: number; why: string }
  // A removal the hub enforces but could not commit: it stands until an
  // admin lets the person back in.
  | { kind: 'standing'; why: string }
  | { kind: 'restored' };

type ConfigFile = { sha: string; branch: string; config: Record<string, unknown> };
type SiteEntry = { repo?: unknown; readers?: unknown; approvers?: unknown } & Record<string, unknown>;

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
  return site ? { readers: strings(site.readers), approvers: strings(site.approvers) } : null;
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

const word = { readers: 'reader', approvers: 'approver' };
const messageOf = (change: AccessChange, email: string) =>
  `chore(config): ${change.action} ${word[change.list]} ${change.entry} ${change.action === 'add' ? 'to' : 'from'} ${change.site}\n\nRequested by ${email} on the hub's admin page.`;

// Who still reads after an exact reader is removed: a domain entry covering them.
const stillReads = (config: Record<string, unknown>, change: AccessChange) => {
  if (change.list !== 'readers' || change.entry.startsWith('@')) return undefined;
  const domain = `@${change.entry.split('@')[1]}`;
  return listsIn(config, change.site)?.readers.includes(domain) ? domain : undefined;
};

// Pending removals fail closed: a removal is recorded before anything else
// and is only ever cleared by an admin (adding the entry back, or letting the
// person back in), never by guessing from what GitHub seems to say.
export const changeAccess = async (
  change: AccessChange,
  ctx: { config: HubConfig; env: Env; auth: GitHubAuth; email: string },
): Promise<Outcome> => {
  const { config, env, auth, email } = ctx;
  const site = config.sites.get(change.site);
  if (!site) return { kind: 'refused', status: 400, why: 'that site is not on the hub' };
  if (change.action === 'restore') {
    await clearPending(env, site.key, change.list, change.entry);
    return { kind: 'restored' };
  }
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
      await clearPendingOlderThan(env, site.key, change.list, change.entry, IN_FLIGHT_MS);
      return { kind: 'unchanged', why: `${change.entry} is already listed; the hub lets them in` };
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
      if (!removing) await clearPending(env, site.key, change.list, change.entry);
      return { kind: 'done', still: stillReads(next.config, change) };
    }
    if (res?.status === 409) return 'conflict';
    if (!res) return failed(502, 'GitHub gave no answer; the commit may or may not have landed, check the history');
    const hint = res.status === 422 || res.status === 403 ? '; the default branch may be protected' : '';
    return failed(502, `GitHub did not take the commit (${res.status})${hint}`);
  };

  const first = await attempt();
  if (first !== 'conflict') return first;
  // Someone changed the file meanwhile: once more on the fresh file.
  const second = await attempt();
  if (second !== 'conflict') return second;
  return failed(409, 'the config file kept changing; try again');
};
