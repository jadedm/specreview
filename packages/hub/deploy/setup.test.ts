import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cloudflare } from './cloudflare';
import { loadOrg } from './org';
import { setup, wantedInclude } from './setup';
import {
  ACCOUNT,
  BARE_HUB,
  CONFIG,
  emptyAccount,
  fakeCloudflare,
  orgDir,
  TOKEN,
  type FakeOptions,
  type FakeState,
} from './test-helpers';

const run = async (
  state: FakeState,
  {
    apply = false,
    hub = BARE_HUB as unknown,
    config = CONFIG as unknown,
    failOn = undefined as FakeOptions['failOn'],
    raw = undefined as FakeOptions['raw'],
    dir = undefined as ReturnType<typeof orgDir> | undefined,
  } = {},
) => {
  const o = dir ?? orgDir(hub, config);
  const fake = fakeCloudflare(state, { failOn, raw });
  const lines: string[] = [];
  const error = await setup(loadOrg(o.dir), cloudflare(o.tokenFile, fake.fetchImpl), {
    apply,
    log: (l) => lines.push(l),
  }).then(
    () => null,
    (e: Error) => e,
  );
  const hubJson = JSON.parse(readFileSync(path.join(o.dir, 'hub.json'), 'utf8')) as typeof BARE_HUB & {
    database: { id?: string };
    bucket: { created?: boolean };
    access?: Record<string, string>;
  };
  return { ...fake, lines, error, hubJson, o };
};

const applied = async () => {
  const state = emptyAccount();
  const first = await run(state, { apply: true });
  expect(first.error).toBeNull();
  return { state, dir: first.o, hub: first.hubJson };
};

describe('9: setup', () => {
  it('8: plan mode only reads, says what it would do, and leaves hub.json alone', async () => {
    const r = await run(emptyAccount());
    expect(r.error).toBeNull();
    expect(r.writes()).toEqual([]);
    expect(r.lines.filter((l) => l.startsWith('plan: '))).toEqual([
      'plan: one-time PIN login: create',
      'plan: D1 specreview: create',
      'plan: R2 specreview-sites: create',
      'plan: Access app for specs.acme.dev: create',
      'plan: Access bypass for specs.acme.dev/_publish/*: create',
      'plan: Access team domain: record acme.cloudflareaccess.com',
    ]);
    expect(r.hubJson).toEqual(BARE_HUB);
  });

  it('9: apply on an empty account creates everything and records every id', async () => {
    const state = emptyAccount();
    const r = await run(state, { apply: true });
    expect(r.error).toBeNull();
    expect(r.hubJson.database.id).toBe(state.d1[0].uuid);
    expect(r.hubJson.bucket.created).toBe(true);
    expect(state.r2).toEqual([{ name: 'specreview-sites' }]);
    const [main, publish] = state.apps;
    expect(r.hubJson.access).toEqual({
      appId: main.id,
      aud: main.aud,
      publishAppId: publish.id,
      teamDomain: 'acme.cloudflareaccess.com',
    });
    expect(main.domain).toBe('specs.acme.dev');
    expect(main.policies.map((p) => [p.name, p.decision])).toEqual([['specreview', 'allow']]);
    expect(main.policies[0].include).toEqual([
      { email: { email: 'owner@acme.dev' } },
      { email: { email: 'riya@partner.example' } },
      { email_domain: { domain: 'acme.dev' } },
      { email_domain: { domain: 'initech.example' } },
    ]);
    const createApp = r.requests.find(
      (q) =>
        q.method === 'POST' &&
        q.path.endsWith('/access/apps') &&
        (q.body as { domain: string }).domain === 'specs.acme.dev',
    );
    expect((createApp?.body as { allowed_idps: string[] }).allowed_idps).toEqual([state.idps[0].id]);
    expect(publish.domain).toBe('specs.acme.dev/_publish/*');
    expect(publish.policies.map((p) => [p.decision, p.include])).toEqual([['bypass', [{ everyone: {} }]]]);
    expect(r.lines.at(-1)).toBe('hub.json updated; commit it');
  });

  it('10: a second apply changes nothing', async () => {
    const { state, dir } = await applied();
    const r = await run(state, { apply: true, dir });
    expect(r.error).toBeNull();
    expect(r.writes()).toEqual([]);
    expect(r.lines.at(-1)).toBe('nothing to do');
  });

  it('11 and 19: the policy follows the config exactly, additions and removals, printing before, wanted and after', async () => {
    const { state, dir } = await applied();
    const config = structuredClone(CONFIG);
    config.sites[0].readers = ['new@partner.example'];
    config.admins = ['boss@acme.dev'];
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path.join(dir.dir, 'specreview.config.json'), JSON.stringify(config));
    const plan = await run(state, { dir });
    expect(plan.writes()).toEqual([]);
    expect(plan.lines).toContain('plan: Access app for specs.acme.dev: update its policy');
    const r = await run(state, { apply: true, dir });
    expect(r.error).toBeNull();
    expect(r.writes().map((w) => w.method)).toEqual(['PUT']);
    const want = [
      { email: { email: 'boss@acme.dev' } },
      { email: { email: 'new@partner.example' } },
      { email_domain: { domain: 'acme.dev' } },
    ];
    expect(state.apps[0].policies[0].include).toEqual(want);
    expect(r.lines.some((l) => l.startsWith('policy before: ') && l.includes('initech.example'))).toBe(true);
    expect(r.lines).toContain(`policy wanted: ${JSON.stringify(want)}`);
    expect(r.lines).toContain(`policy after: ${JSON.stringify(want)}`);
  });

  it('12 and 16: Zero Trust off, an account the token cannot read, a non-JSON answer, or success false stop it', async () => {
    const off = emptyAccount();
    off.accessEnabled = false;
    expect((await run(off, { apply: true })).error?.message).toMatch(/Zero Trust is not enabled/);
    const elsewhere = emptyAccount();
    elsewhere.accounts = ['ffffffffffffffffffffffffffffffff'];
    const denied = await run(elsewhere, { apply: true });
    expect(denied.error?.message).toMatch(`the token cannot read account ${ACCOUNT}`);
    expect(denied.requests).toHaveLength(1);
    const html = await run(emptyAccount(), {
      apply: true,
      raw: (q) => (q.path.startsWith('/zones') ? new Response('<html>oops</html>', { status: 502 }) : null),
    });
    expect(html.error?.message).toMatch(/not JSON/);
    const refused = await run(emptyAccount(), { apply: true, failOn: (q) => q.path.includes('/identity_providers') });
    expect(refused.error?.message).toMatch(/Cloudflare refused GET .*identity_providers.*injected failure/);
    for (const r of [denied, html, refused]) expect(r.writes()).toEqual([]);
  });

  it('13 and 20: apps changed by hand are refused and nothing is written', async () => {
    const cases: [string, (s: FakeState) => void, RegExp][] = [
      [
        'a second policy',
        (s) => s.apps[0].policies.push({ id: 'x', name: 'mine', decision: 'allow', include: [{ everyone: {} }] }),
        /policies other than/,
      ],
      [
        'a require rule',
        (s) => (s.apps[0].policies[0].require = [{ email_domain: { domain: 'acme.dev' } }]),
        /require, exclude or non-email/,
      ],
      [
        'a service token rule',
        (s) => s.apps[0].policies[0].include.push({ any_valid_service_token: {} }),
        /require, exclude or non-email/,
      ],
      ['another domain', (s) => (s.apps[0].domain = 'other.acme.dev'), /changed by hand/],
      [
        'a bypass that is not for everyone',
        (s) => (s.apps[1].policies[0].include = [{ email_domain: { domain: 'acme.dev' } }]),
        /not a single bypass-everyone/,
      ],
      ['a bypass on another path', (s) => (s.apps[1].domain = 'specs.acme.dev/*'), /changed by hand/],
    ];
    for (const [name, change, why] of cases) {
      const { state, dir } = await applied();
      change(state);
      const r = await run(state, { apply: true, dir });
      expect(r.error?.message, name).toMatch(why);
      expect(r.error?.message, name).toMatch(/stopped before changing anything/);
      expect(r.writes(), name).toEqual([]);
    }
  });

  it('17: a database, bucket or app with the wanted name but no recorded id is refused, not adopted', async () => {
    const state = emptyAccount();
    state.d1.push({ uuid: 'someone-elses', name: 'specreview' });
    state.r2.push({ name: 'specreview-sites' });
    state.apps.push({ id: 'theirs', domain: 'specs.acme.dev', type: 'self_hosted', aud: 'a', name: 'x', policies: [] });
    const r = await run(state, { apply: true });
    expect(r.error?.message).toMatch(/D1 database named specreview exists but is not recorded/);
    expect(r.error?.message).toMatch(/R2 bucket named specreview-sites exists but is not recorded/);
    expect(r.error?.message).toMatch(/Access app for specs.acme.dev exists but is not recorded/);
    expect(r.writes()).toEqual([]);
  });

  it('18: a run that fails part way records what it made, and the rerun makes only the rest', async () => {
    const state = emptyAccount();
    const first = await run(state, {
      apply: true,
      failOn: (q) => q.method === 'POST' && q.path.endsWith('/r2/buckets'),
    });
    expect(first.error?.message).toMatch(/injected failure/);
    expect(first.hubJson.database.id).toBe(state.d1[0].uuid);
    expect(first.hubJson.bucket.created).toBeUndefined();
    const second = await run(state, { apply: true, dir: first.o });
    expect(second.error).toBeNull();
    expect(state.d1).toHaveLength(1);
    expect(state.idps).toHaveLength(1);
    expect(second.writes().map((w) => w.path.replace(`/accounts/${ACCOUNT}`, ''))).toEqual([
      '/r2/buckets',
      '/access/apps',
      '/access/apps',
    ]);
  });

  it("21: hub.json's audience differing from the app's is refused", async () => {
    const { state, dir } = await applied();
    state.apps[0].aud = 'recreated';
    const r = await run(state, { apply: true, dir });
    expect(r.error?.message).toMatch(/audience differs/);
  });

  it('22: an existing one-time PIN login is reused; other login methods are left alone; rules are email only', async () => {
    const state = emptyAccount();
    state.idps.push({ id: 'google', type: 'google' }, { id: 'otp-1', type: 'onetimepin' });
    const r = await run(state, { apply: true });
    expect(r.error).toBeNull();
    expect(r.writes().some((w) => w.path.includes('identity_providers'))).toBe(false);
    expect(state.idps.map((p) => p.id)).toEqual(['google', 'otp-1']);
    const kinds = new Set(state.apps[0].policies[0].include.flatMap((rule) => Object.keys(rule as object)));
    expect([...kinds].sort()).toEqual(['email', 'email_domain']);
  });

  it('23: lists are read to the last page', async () => {
    const state = emptyAccount();
    for (let i = 0; i < 5; i++)
      state.apps.push({
        id: `filler-${i}`,
        domain: `x${i}.acme.dev`,
        type: 'self_hosted',
        aud: 'a',
        name: 'f',
        policies: [],
      });
    state.apps.push({
      id: 'late',
      domain: 'specs.acme.dev',
      type: 'self_hosted',
      aud: 'a',
      name: 'theirs',
      policies: [],
    });
    for (let i = 0; i < 4; i++) state.zones.unshift({ id: `zz${i}`, name: `other${i}.dev`, status: 'active' });
    const r = await run(state, { apply: true });
    expect(r.error?.message).toMatch(/Access app for specs.acme.dev exists but is not recorded/);
    expect(r.error?.message).not.toMatch(/no zone/);
    expect(
      r.requests
        .filter((q) => q.path.includes('/access/apps?'))
        .map((q) => new URL(`http://x${q.path}`).searchParams.get('page')),
    ).toEqual(['1', '2', '3']);
  });

  it('24: a hostname without an active zone, with a DNS record, or on another Worker is refused before anything is created', async () => {
    const cases: [string, (s: FakeState) => void, RegExp][] = [
      [
        'no zone',
        (s) => (s.zones = [{ id: 'z9', name: 'elsewhere.dev', status: 'active' }]),
        /no zone .* covers specs.acme.dev/,
      ],
      ['pending zone', (s) => (s.zones[0].status = 'pending'), /zone acme.dev is pending/],
      ['a DNS record', (s) => s.dns.z1.push({ name: 'specs.acme.dev' }), /already has a DNS record/],
      [
        'another Worker',
        (s) => s.workerDomains.push({ hostname: 'specs.acme.dev', service: 'their-worker' }),
        /custom domain of Worker their-worker/,
      ],
    ];
    for (const [name, change, why] of cases) {
      const state = emptyAccount();
      change(state);
      const r = await run(state, { apply: true });
      expect(r.error?.message, name).toMatch(why);
      expect(r.writes(), name).toEqual([]);
    }
    const deployed = emptyAccount();
    deployed.dns.z1.push({ name: 'specs.acme.dev' });
    deployed.workerDomains.push({ hostname: 'specs.acme.dev', service: 'specreview-hub' });
    expect((await run(deployed, { apply: true })).error).toBeNull();
  });

  it('6: the token goes only in the authorization header and never into output', async () => {
    const r = await run(emptyAccount(), { apply: true });
    expect(new Set(r.requests.map((q) => q.auth))).toEqual(new Set([`Bearer ${TOKEN}`]));
    expect(r.lines.join('\n')).not.toContain(TOKEN);
    expect(r.requests.some((q) => q.path.includes(TOKEN) || JSON.stringify(q.body ?? '').includes(TOKEN))).toBe(false);
  });

  it('2: a config the hub would refuse stops setup before any call', async () => {
    const config = structuredClone(CONFIG);
    config.sites[0].approvers = ['pm@elsewhere.dev'];
    const r = await run(emptyAccount(), { apply: true, config });
    expect(r.error?.message).toMatch(/approvers has an email outside the team domains/);
    expect(r.requests).toEqual([]);
  });

  it('wantedInclude merges team domains, readers and admins without duplicates', () => {
    const config = structuredClone(CONFIG);
    config.sites.push({ ...config.sites[0], repo: 'web', readers: ['@initech.example'] });
    expect(wantedInclude(config)).toHaveLength(4);
  });
});
