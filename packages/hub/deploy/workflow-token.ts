// The Cloudflare token the hub repo's apply workflow keeps as its
// CLOUDFLARE_API_TOKEN secret (#66): only what a run on an installed hub does.
// It is created from a laptop with the install token, and its value goes to a
// file and nowhere else.
import { closeSync, fchmodSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { CloudflareError, readToken, type Cloudflare } from './cloudflare';
import { DeployError, type Org } from './org';
import { zoneCovering, type Zone } from './setup';

// The install token's other powers are not needed after the first install:
// the one-time PIN login is created then (setup), so identity providers stay
// Read. R2 is Write because adding or removing a logo later writes objects.
export const WORKFLOW_PERMISSIONS = {
  account: [
    'Account Settings Read',
    'Access: Apps and Policies Write',
    'Access: Organizations, Identity Providers, and Groups Read',
    'D1 Write',
    'Workers R2 Storage Write',
    'Workers Scripts Write',
  ],
  zone: ['Zone Read', 'DNS Read', 'Workers Routes Write'],
} as const;

const SCOPE = { account: 'com.cloudflare.api.account', zone: 'com.cloudflare.api.account.zone' } as const;

type Kind = 'account' | 'user';
type Group = { id?: unknown; name?: unknown; scopes?: unknown; is_selectable?: unknown };

const verifies = (cf: Cloudflare, path: string) =>
  cf.call('GET', path).then(
    () => true,
    () => false,
  );

// Whose token it is decides which endpoints manage tokens. Read from the
// token's own prefix; a token from before prefixes is asked of Cloudflare.
export const tokenKind = async (token: string, cf: Cloudflare, accountId: string): Promise<Kind> => {
  if (token.startsWith('cfat_')) return 'account';
  if (token.startsWith('cfut_')) return 'user';
  if (/^cf[a-z]*_/.test(token))
    throw new DeployError('--token-file holds a Cloudflare credential that is not an API token; use an API token');
  if (await verifies(cf, '/user/tokens/verify')) return 'user';
  if (await verifies(cf, `/accounts/${accountId}/tokens/verify`)) return 'account';
  throw new DeployError('Cloudflare does not recognise the token in --token-file as a user or account API token');
};

// One selectable group per name, at the scope it is wanted for. Cloudflare
// documents is_selectable for account catalogues only, so only an explicit
// false rules a group out.
export const resolveGroups = (groups: Group[], names: readonly string[], scope: string) =>
  names.map((name) => {
    const found = groups.filter(
      (g) =>
        g.name === name &&
        typeof g.id === 'string' &&
        Array.isArray(g.scopes) &&
        g.scopes.includes(scope) &&
        g.is_selectable !== false,
    );
    if (found.length !== 1)
      throw new DeployError(
        found.length === 0
          ? `Cloudflare has no permission "${name}" for ${scope === SCOPE.zone ? 'zones' : 'accounts'}`
          : `Cloudflare has more than one permission "${name}" for ${scope === SCOPE.zone ? 'zones' : 'accounts'}`,
      );
    return { id: found[0].id as string };
  });

// The file is reserved before the token exists, so a token is never made that
// cannot be kept, and no existing file (or what a symlink points at) is touched.
const reserve = (out: string) => {
  try {
    const fd = openSync(out, 'wx', 0o600);
    fchmodSync(fd, 0o600);
    return fd;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new DeployError(
      code === 'EEXIST'
        ? `${out} already exists (an interrupted run can leave it empty); name a new file`
        : `cannot create ${out}: ${code}`,
    );
  }
};

// Closes and removes the reserved file, whatever closing does; true if it is gone.
const release = (fd: number, out: string) => {
  try {
    closeSync(fd);
  } catch {
    // Already closed: the file is removed below all the same.
  }
  try {
    unlinkSync(out);
    return true;
  } catch {
    return false;
  }
};

export const workflowToken = async (opts: {
  org: Org;
  tokenFile: string;
  out: string;
  cf: Cloudflare;
  log: (line: string) => void;
  // Tests make the write fail; anything else uses the file system's.
  write?: (fd: number, text: string) => void;
  // Tests fix the date in the token's name.
  now?: Date;
}) => {
  const { org, cf, out, log } = opts;
  const { accountId: a, hostname: host } = org.hub;
  const fd = reserve(out);
  let created: { id: string; value: string; name: string };
  try {
    const kind = await tokenKind(readToken(opts.tokenFile), cf, a);
    const base = kind === 'account' ? `/accounts/${a}/tokens` : '/user/tokens';
    const zone = zoneCovering(await cf.list<Zone>(`/zones?account.id=${a}`), host);
    if (!zone) throw new DeployError(`no zone in account ${a} covers ${host}`);
    if (zone.status !== 'active') throw new DeployError(`zone ${zone.name} is ${zone.status}, not active`);
    const groups = await cf.call<Group[]>('GET', `${base}/permission_groups`);
    const catalogue = Array.isArray(groups) ? groups : [];
    const account = resolveGroups(catalogue, WORKFLOW_PERMISSIONS.account, SCOPE.account);
    const zoneGroups = resolveGroups(catalogue, WORKFLOW_PERMISSIONS.zone, SCOPE.zone);
    // Stamped to the second (UTC), so a token from a run whose answer was lost
    // can be told apart from any other; Cloudflare takes at most 120 characters.
    const stamp = `${(opts.now ?? new Date()).toISOString().slice(0, 19)}Z`;
    const name = `${`specreview apply ${host}`.slice(0, 120 - stamp.length - 1)} ${stamp}`;
    const answer = await cf
      .call<{ id?: unknown; value?: unknown }>('POST', base, {
        name,
        policies: [
          { effect: 'allow', resources: { [`${SCOPE.account}.${a}`]: '*' }, permission_groups: account },
          { effect: 'allow', resources: { [`${SCOPE.zone}.${zone.id}`]: '*' }, permission_groups: zoneGroups },
        ],
      })
      .catch((e: unknown) => {
        // A refusal (4xx) made nothing. No answer, a reply that is not JSON
        // or a server error may have come after the token was made.
        if (e instanceof CloudflareError && e.status < 500) throw e;
        throw new DeployError(
          `Cloudflare did not answer the token create (${e instanceof Error ? e.message : String(e)}); a token named "${name}" may exist: delete it in the dashboard before running again`,
        );
      });
    if (typeof answer?.value !== 'string' || !answer.value)
      throw new DeployError(
        typeof answer?.id === 'string'
          ? `Cloudflare created token ${answer.id} but sent no value; delete it in the dashboard`
          : `Cloudflare sent no token in its answer; a token named "${name}" may exist: delete it in the dashboard before running again`,
      );
    created = { id: typeof answer.id === 'string' ? answer.id : '', value: answer.value, name };
  } catch (e) {
    release(fd, out);
    throw e;
  }
  const named = created.id ? `token ${created.id}` : `token "${created.name}"`;
  try {
    // writeFileSync keeps writing until every byte is down, or throws.
    (opts.write ?? ((f: number, t: string) => writeFileSync(f, t)))(fd, `${created.value}\n`);
    closeSync(fd);
  } catch (e) {
    const removed = release(fd, out);
    throw new DeployError(
      `${named} was created but could not be written to ${out} (${(e as NodeJS.ErrnoException).code})${removed ? '' : `; remove ${out} by hand`}; delete the token in the dashboard`,
    );
  }
  log(`created token "${created.name}"${created.id ? ` (${created.id})` : ''}, value in ${out}`);
  log(`  account ${a}: ${WORKFLOW_PERMISSIONS.account.join(', ')}`);
  log(`  zone of ${host}: ${WORKFLOW_PERMISSIONS.zone.join(', ')}`);
  log(`next, from this repo: gh secret set CLOUDFLARE_API_TOKEN < ${out}`);
};
