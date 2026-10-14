import { closeSync, existsSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs } from './cli';
import { CloudflareError, cloudflare, permissionFor } from './cloudflare';
import { loadOrg } from './org';
import { ACCOUNT, emptyAccount, fakeCloudflare, orgDir, type FakeState, type Request } from './test-helpers';
import { WORKFLOW_PERMISSIONS, workflowToken } from './workflow-token';

// #66: the apply workflow's token, created from the install token. A stand-in
// for Cloudflare's token endpoints sits in front of the shared fake.
const NEW_VALUE = 'cfat_new-token-value-never-printed';
const ACCOUNT_SCOPE = 'com.cloudflare.api.account';
const ZONE_SCOPE = 'com.cloudflare.api.account.zone';

type Group = { id: string; name: string; scopes: string[]; is_selectable: boolean };
const catalogue = (): Group[] => [
  ...WORKFLOW_PERMISSIONS.account.map((name, i) => ({
    id: `a${i}`,
    name,
    scopes: [ACCOUNT_SCOPE],
    is_selectable: true,
  })),
  ...WORKFLOW_PERMISSIONS.zone.map((name, i) => ({ id: `z${i}`, name, scopes: [ZONE_SCOPE], is_selectable: true })),
  // The same names at the other scope, as Cloudflare lists some (Access, DNS).
  { id: 'wrong-scope', name: 'Access: Apps and Policies Write', scopes: [ZONE_SCOPE], is_selectable: true },
  { id: 'unrelated', name: 'Billing Read', scopes: [ACCOUNT_SCOPE], is_selectable: true },
];

type Stand = {
  groups?: Group[];
  legacy?: 'user' | 'account' | 'neither';
  create?: (r: Request) => Response;
};
const ok = (result: unknown) => Response.json({ success: true, errors: [], result });
const no = (status: number, message: string) =>
  Response.json({ success: false, errors: [{ code: 9109, message }], result: null }, { status });

const run = async (
  token: string,
  {
    stand = {} as Stand,
    state = emptyAccount() as FakeState,
    write = undefined as ((fd: number, text: string) => void) | undefined,
  } = {},
) => {
  const o = orgDir();
  writeFileSync(o.tokenFile, `${token}\n`);
  const outFile = path.join(o.dir, 'apply-token');
  const tokenRoutes = (r: Request): Response | null => {
    const p = r.path.split('?')[0];
    const base = p.startsWith('/user/') ? '/user/tokens' : `/accounts/${ACCOUNT}/tokens`;
    if (p === '/user/tokens/verify') return stand.legacy === 'user' ? ok({ status: 'active' }) : no(401, 'Invalid');
    if (p === `/accounts/${ACCOUNT}/tokens/verify`)
      return stand.legacy === 'account' ? ok({ status: 'active' }) : no(401, 'Invalid');
    if (p === `${base}/permission_groups`) return ok(stand.groups ?? catalogue());
    if (p === base && r.method === 'POST')
      return stand.create?.(r) ?? ok({ id: 'tok-1', name: (r.body as { name: string }).name, value: NEW_VALUE });
    return null;
  };
  const fake = fakeCloudflare(state, { raw: tokenRoutes });
  const lines: string[] = [];
  const error = await workflowToken({
    org: loadOrg(o.dir),
    tokenFile: o.tokenFile,
    out: outFile,
    cf: cloudflare(o.tokenFile, fake.fetchImpl),
    log: (l) => lines.push(l),
    write,
  }).then(
    () => null,
    (e: Error) => e,
  );
  const creates = fake.requests.filter((r) => r.method === 'POST');
  return { ...fake, lines, error, outFile, creates, o };
};

const noLeak = (r: Awaited<ReturnType<typeof run>>) => {
  expect(r.lines.join('\n')).not.toContain(NEW_VALUE);
  expect(r.error?.message ?? '').not.toContain(NEW_VALUE);
  expect(JSON.stringify(r.requests)).not.toContain(NEW_VALUE);
};

describe('#66 workflow-token', () => {
  it('1: an account-owned token creates the narrow token scoped to the account and zone; the value goes only to the file', async () => {
    const r = await run('cfat_install-token');
    expect(r.error).toBeNull();
    expect(r.creates).toHaveLength(1);
    expect(r.creates[0].path).toBe(`/accounts/${ACCOUNT}/tokens`);
    expect(r.creates[0].body).toEqual({
      name: 'specreview apply specs.acme.dev',
      policies: [
        {
          effect: 'allow',
          resources: { [`${ACCOUNT_SCOPE}.${ACCOUNT}`]: '*' },
          permission_groups: WORKFLOW_PERMISSIONS.account.map((_, i) => ({ id: `a${i}` })),
        },
        {
          effect: 'allow',
          resources: { [`${ZONE_SCOPE}.z1`]: '*' },
          permission_groups: WORKFLOW_PERMISSIONS.zone.map((_, i) => ({ id: `z${i}` })),
        },
      ],
    });
    expect(readFileSync(r.outFile, 'utf8')).toBe(`${NEW_VALUE}\n`);
    expect(statSync(r.outFile).mode & 0o777).toBe(0o600);
    expect(r.lines[0]).toBe(`created token "specreview apply specs.acme.dev" (tok-1), value in ${r.outFile}`);
    expect(r.lines.at(-1)).toBe(`next, from this repo: gh secret set CLOUDFLARE_API_TOKEN < ${r.outFile}`);
    noLeak(r);
  });

  it('2: a user token uses the user endpoints', async () => {
    const r = await run('cfut_install-token');
    expect(r.error).toBeNull();
    expect(r.creates.map((c) => c.path)).toEqual(['/user/tokens']);
    expect(r.requests.some((q) => q.path === '/user/tokens/permission_groups')).toBe(true);
  });

  it('2: a token from before prefixes is asked of Cloudflare, user first, then the account', async () => {
    const user = await run('legacy40charactertokenvalue0000000000000', { stand: { legacy: 'user' } });
    expect(user.creates.map((c) => c.path)).toEqual(['/user/tokens']);
    const account = await run('legacy40charactertokenvalue0000000000000', { stand: { legacy: 'account' } });
    expect(account.creates.map((c) => c.path)).toEqual([`/accounts/${ACCOUNT}/tokens`]);
    const neither = await run('legacy40charactertokenvalue0000000000000', { stand: { legacy: 'neither' } });
    expect(neither.error?.message).toContain('does not recognise the token');
    expect(neither.creates).toEqual([]);
    expect(existsSync(neither.outFile)).toBe(false);
  });

  it('2: another kind of Cloudflare credential is refused before any call', async () => {
    const r = await run('cfk_global-key');
    expect(r.error?.message).toContain('not an API token');
    expect(r.requests).toEqual([]);
    expect(existsSync(r.outFile)).toBe(false);
  });

  it('a catalogue without is_selectable (as user catalogues may be) still resolves', async () => {
    const bare = catalogue().map(({ is_selectable: _s, ...g }) => g) as unknown as Group[];
    const r = await run('cfut_x', { stand: { groups: bare } });
    expect(r.error).toBeNull();
    expect(r.creates).toHaveLength(1);
  });

  it('an answer with a value but no id keeps the value and names the token by its name', async () => {
    const r = await run('cfat_x', { stand: { create: () => ok({ value: NEW_VALUE }) } });
    expect(r.error).toBeNull();
    expect(readFileSync(r.outFile, 'utf8')).toBe(`${NEW_VALUE}\n`);
    expect(r.lines[0]).toBe(`created token "specreview apply specs.acme.dev", value in ${r.outFile}`);
    noLeak(r);
  });

  it('3: the list does not depend on the config: R2 is Write with or without a logo', async () => {
    expect(WORKFLOW_PERMISSIONS.account).toContain('Workers R2 Storage Write');
    expect(WORKFLOW_PERMISSIONS.account).toContain('Access: Organizations, Identity Providers, and Groups Read');
  });

  it('4, 5, 6: a missing, doubled, unselectable or wrong-scope permission refuses before creating anything', async () => {
    const without = catalogue().filter((g) => g.name !== 'D1 Write');
    const missing = await run('cfat_x', { stand: { groups: without } });
    expect(missing.error?.message).toBe('Cloudflare has no permission "D1 Write" for accounts');
    const doubled = await run('cfat_x', {
      stand: { groups: [...catalogue(), { id: 'dup', name: 'DNS Read', scopes: [ZONE_SCOPE], is_selectable: true }] },
    });
    expect(doubled.error?.message).toBe('Cloudflare has more than one permission "DNS Read" for zones');
    const locked = catalogue().map((g) => (g.name === 'Zone Read' ? { ...g, is_selectable: false } : g));
    const unselectable = await run('cfat_x', { stand: { groups: locked } });
    expect(unselectable.error?.message).toBe('Cloudflare has no permission "Zone Read" for zones');
    // Only at the account scope: a zone permission is never taken from there.
    const moved = catalogue().map((g) => (g.name === 'Workers Routes Write' ? { ...g, scopes: [ACCOUNT_SCOPE] } : g));
    const wrongScope = await run('cfat_x', { stand: { groups: moved } });
    expect(wrongScope.error?.message).toBe('Cloudflare has no permission "Workers Routes Write" for zones');
    for (const r of [missing, doubled, unselectable, wrongScope]) {
      expect(r.creates).toEqual([]);
      expect(existsSync(r.outFile)).toBe(false);
    }
  });

  it('7: an existing file or symlink at --out is refused before any call and left as it was', async () => {
    const o = orgDir();
    const taken = path.join(o.dir, 'taken');
    writeFileSync(taken, 'keep me');
    const fake = fakeCloudflare(emptyAccount());
    const lines: string[] = [];
    const err = await workflowToken({
      org: loadOrg(o.dir),
      tokenFile: o.tokenFile,
      out: taken,
      cf: cloudflare(o.tokenFile, fake.fetchImpl),
      log: (l) => lines.push(l),
    }).catch((e: Error) => e);
    expect(err?.message).toBe(`${taken} already exists (an interrupted run can leave it empty); name a new file`);
    expect(readFileSync(taken, 'utf8')).toBe('keep me');
    expect(fake.requests).toEqual([]);
    const target = path.join(o.dir, 'target');
    writeFileSync(target, 'target');
    const link = path.join(o.dir, 'link');
    symlinkSync(target, link);
    const viaLink = await workflowToken({
      org: loadOrg(o.dir),
      tokenFile: o.tokenFile,
      out: link,
      cf: cloudflare(o.tokenFile, fake.fetchImpl),
      log: () => {},
    }).catch((e: Error) => e);
    expect(viaLink?.message).toContain('already exists');
    expect(readFileSync(target, 'utf8')).toBe('target');
  });

  it('8: no zone covering the hostname, or an inactive one, refuses before creating', async () => {
    const none = emptyAccount();
    none.zones = [{ id: 'z9', name: 'other.dev', status: 'active' }];
    const a = await run('cfat_x', { state: none });
    expect(a.error?.message).toBe(`no zone in account ${ACCOUNT} covers specs.acme.dev`);
    const pending = emptyAccount();
    pending.zones = [{ id: 'z1', name: 'acme.dev', status: 'pending' }];
    const b = await run('cfat_x', { state: pending });
    expect(b.error?.message).toBe('zone acme.dev is pending, not active');
    for (const r of [a, b]) {
      expect(r.creates).toEqual([]);
      expect(existsSync(r.outFile)).toBe(false);
    }
  });

  it('9: a create the token may not make names the permission it lacks, and leaves no file', async () => {
    const account = await run('cfat_x', {
      stand: { create: () => no(403, 'Unauthorized to access requested resource') },
    });
    expect(account.error?.message).toMatch(/the token may lack Account API Tokens Write$/);
    expect(existsSync(account.outFile)).toBe(false);
    const user = await run('cfut_x', { stand: { create: () => no(403, 'Unauthorized to access requested resource') } });
    expect(user.error?.message).toMatch(/the token may lack API Tokens Write$/);
  });

  it('10: a value that cannot be written leaves no file and names the token to delete', async () => {
    const r = await run('cfat_x', {
      write: () => {
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      },
    });
    expect(r.error?.message).toBe(
      `token tok-1 was created but could not be written to ${r.outFile} (ENOSPC); delete the token in the dashboard`,
    );
    expect(existsSync(r.outFile)).toBe(false);
    noLeak(r);
  });

  it('10: the file is removed even when closing it fails during cleanup', async () => {
    const r = await run('cfat_x', {
      write: (fd) => {
        closeSync(fd);
        throw Object.assign(new Error('io'), { code: 'EIO' });
      },
    });
    expect(r.error?.message).toContain('token tok-1 was created but could not be written');
    expect(r.error?.message).not.toContain('remove');
    expect(existsSync(r.outFile)).toBe(false);
  });

  it('10: an answer without a value is an error that names the token if it has one', async () => {
    const empty = await run('cfat_x', { stand: { create: () => ok({ id: 'tok-7', name: 'n' }) } });
    expect(empty.error?.message).toBe('Cloudflare created token tok-7 but sent no value; delete it in the dashboard');
    expect(existsSync(empty.outFile)).toBe(false);
    const nothing = await run('cfat_x', { stand: { create: () => ok(null) } });
    expect(nothing.error?.message).toBe('Cloudflare sent no token in its answer');
  });

  it('11: --out is required', () => {
    expect(() => parseArgs(['workflow-token', '--org', '.', '--token-file', 't']).need('--out')).toThrow(
      'workflow-token needs --out',
    );
  });
});

describe('#66 permission hints on 403', () => {
  it('12: names the permission a call needs, Read for GET and Write otherwise', () => {
    expect(permissionFor('GET', `/accounts/${ACCOUNT}/d1/database?name=x`)).toBe('D1 Read');
    expect(permissionFor('POST', `/accounts/${ACCOUNT}/access/policies`)).toBe('Access: Apps and Policies Write');
    expect(permissionFor('POST', `/accounts/${ACCOUNT}/access/identity_providers`)).toBe(
      'Access: Organizations, Identity Providers, and Groups Write',
    );
    expect(permissionFor('GET', '/zones/z1/dns_records?name=a')).toBe('DNS Read');
    expect(permissionFor('GET', `/zones?account.id=${ACCOUNT}`)).toBe('Zone Read');
    expect(permissionFor('GET', `/accounts/${ACCOUNT}`)).toBe('Account Settings Read');
    expect(permissionFor('GET', `/accounts/${ACCOUNT}/workers/scripts/w/secrets`)).toBe('Workers Scripts Read');
    expect(permissionFor('POST', `/accounts/${ACCOUNT}/r2/buckets`)).toBe('Workers R2 Storage Write');
    expect(permissionFor('POST', '/user/tokens')).toBe('API Tokens Write');
    expect(permissionFor('GET', `/accounts/${ACCOUNT}/somewhere/else`)).toBeUndefined();
  });

  it('12: only a 403 carries the hint', () => {
    const path403 = `/accounts/${ACCOUNT}/d1/database`;
    expect(new CloudflareError(403, [], 'GET', path403).message).toMatch(/the token may lack D1 Read$/);
    expect(new CloudflareError(404, [], 'GET', path403).message).not.toContain('may lack');
    expect(new CloudflareError(500, [], 'GET', path403).message).not.toContain('may lack');
    expect(new CloudflareError(403, [], 'GET', `/accounts/${ACCOUNT}/somewhere`).message).not.toContain('may lack');
  });
});

describe('#66 README', () => {
  it('15: lists the workflow token exactly as the command creates it, and both token-management names', () => {
    const readme = readFileSync(path.join(__dirname, '../../../examples/org/README.md'), 'utf8');
    const section = readme.split('### Workflow token')[1]?.split('\n## ')[0] ?? '';
    const accountLine = section.split('\n').find((l) => l.startsWith('- Account:')) ?? '';
    const zoneLine = section.split('\n').find((l) => l.startsWith('- Zone')) ?? '';
    const listed = (line: string) =>
      line
        .replace(/^- [^:]+:\s*/, '')
        .replace(/\.$/, '')
        .split('; ');
    expect(listed(accountLine)).toEqual([...WORKFLOW_PERMISSIONS.account]);
    expect(listed(zoneLine)).toEqual([...WORKFLOW_PERMISSIONS.zone]);
    expect(readme).toContain('Account API Tokens Write');
    expect(readme).toContain('API Tokens Write (for a user token)');
  });
});
