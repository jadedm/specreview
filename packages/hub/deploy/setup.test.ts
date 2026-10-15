import { readFileSync, writeFileSync } from 'node:fs';
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

type HubJson = typeof BARE_HUB & {
  database: { id?: string };
  bucket: { created?: boolean };
  access?: Record<string, string>;
};

const run = async (
  state: FakeState,
  {
    apply = false,
    hub = BARE_HUB as unknown,
    config = CONFIG as unknown,
    fake: fakeOpts = {} as FakeOptions,
    dir = undefined as ReturnType<typeof orgDir> | undefined,
  } = {},
) => {
  const o = dir ?? orgDir(hub, config);
  const fake = fakeCloudflare(state, fakeOpts);
  const lines: string[] = [];
  const error = await setup(loadOrg(o.dir), cloudflare(o.tokenFile, fake.fetchImpl), {
    apply,
    log: (l) => lines.push(l),
  }).then(
    () => null,
    (e: Error) => e,
  );
  const hubJson = JSON.parse(readFileSync(path.join(o.dir, 'hub.json'), 'utf8')) as HubJson;
  return { ...fake, lines, error, hubJson, o };
};

const applied = async () => {
  const state = emptyAccount();
  const first = await run(state, { apply: true });
  expect(first.error).toBeNull();
  return { state, dir: first.o, hub: first.hubJson };
};

const WANT = [
  { email: { email: 'owner@acme.dev' } },
  { email: { email: 'riya@partner.example' } },
  { email_domain: { domain: 'acme.dev' } },
  { email_domain: { domain: 'initech.example' } },
];

describe('9: setup', () => {
  it('8: plan mode only reads, says what it would do, and leaves hub.json alone', async () => {
    const r = await run(emptyAccount());
    expect(r.error).toBeNull();
    expect(r.writes()).toEqual([]);
    expect(r.lines.filter((l) => l.startsWith('plan: '))).toEqual([
      'plan: one-time PIN login: create',
      'plan: D1 specreview: create',
      'plan: R2 specreview-sites: create',
      'plan: Access policy specreview specs.acme.dev: create',
      'plan: Access policy specreview specs.acme.dev publish: create',
      'plan: Access app for specs.acme.dev: create',
      'plan: Access bypass for specs.acme.dev/_publish/*: create',
      'plan: Access team domain: record acme.cloudflareaccess.com',
    ]);
    expect(r.hubJson).toEqual(BARE_HUB);
  });

  it('9: apply on an empty account creates everything with reusable policies and records every id', async () => {
    const state = emptyAccount();
    const r = await run(state, { apply: true });
    expect(r.error).toBeNull();
    expect(r.hubJson.database.id).toBe(state.d1[0].uuid);
    expect(r.hubJson.bucket.created).toBe(true);
    expect(state.r2).toEqual([{ name: 'specreview-sites' }]);
    const [allow, bypass] = state.policies;
    const [main, publish] = state.apps;
    expect(r.hubJson.access).toEqual({
      policyId: allow.id,
      publishPolicyId: bypass.id,
      appId: main.id,
      aud: main.aud,
      publishAppId: publish.id,
      teamDomain: 'acme.cloudflareaccess.com',
    });
    expect([allow.decision, allow.include]).toEqual(['allow', WANT]);
    expect([bypass.decision, bypass.include]).toEqual(['bypass', [{ everyone: {} }]]);
    expect([main.domain, main.policies.map((p) => p.id), main.allowed_idps]).toEqual([
      'specs.acme.dev',
      [allow.id],
      [state.idps[0].id],
    ]);
    expect([publish.domain, publish.policies.map((p) => p.id)]).toEqual(['specs.acme.dev/_publish/*', [bypass.id]]);
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
    writeFileSync(path.join(dir.dir, 'specreview.config.json'), JSON.stringify(config));
    const plan = await run(state, { dir });
    expect(plan.writes()).toEqual([]);
    expect(plan.lines).toContain('plan: Access policy specreview specs.acme.dev: update');
    const hubBytes = readFileSync(path.join(dir.dir, 'hub.json'), 'utf8');
    const r = await run(state, { apply: true, dir });
    expect(r.error).toBeNull();
    // #66: an update records no id, so hub.json is untouched and setup says so.
    expect(r.lines.at(-1)).toBe('done; hub.json unchanged');
    expect(readFileSync(path.join(dir.dir, 'hub.json'), 'utf8')).toBe(hubBytes);
    expect(r.writes().map((w) => [w.method, w.path.replace(`/accounts/${ACCOUNT}`, '')])).toEqual([
      ['PUT', `/access/policies/${state.policies[0].id}`],
    ]);
    const want = [
      { email: { email: 'boss@acme.dev' } },
      { email: { email: 'new@partner.example' } },
      { email_domain: { domain: 'acme.dev' } },
    ];
    expect(state.policies[0].include).toEqual(want);
    expect(r.lines.some((l) => l.startsWith('policy before: ') && l.includes('initech.example'))).toBe(true);
    expect(r.lines).toContain(`policy wanted: ${JSON.stringify(want)}`);
    expect(r.lines).toContain(`policy after: ${JSON.stringify(want)}`);
  });

  it('12 and 16: Zero Trust off, an unreadable account, a non-JSON answer, or a refusal stop it', async () => {
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
      fake: { raw: (q) => (q.path.startsWith('/zones') ? new Response('<html>oops</html>', { status: 502 }) : null) },
    });
    expect(html.error?.message).toMatch(/not JSON/);
    const refused = await run(emptyAccount(), {
      apply: true,
      fake: { failOn: (q) => q.path.includes('/identity_providers') },
    });
    expect(refused.error?.message).toMatch(/Cloudflare refused GET .*identity_providers.*injected failure/);
    const d1Down = await run(emptyAccount(), {
      apply: true,
      hub: { ...BARE_HUB, database: { name: 'specreview', id: '00000000-0000-0000-0000-000000000000' } },
      fake: { failOn: (q) => q.path.includes('/d1/database/') },
    });
    expect(d1Down.error?.message).toMatch(/Cloudflare refused GET .*d1\/database.*injected failure/);
    for (const r of [denied, html, refused, d1Down]) expect(r.writes()).toEqual([]);
  });

  it('13 and 20: policies and apps changed by hand are refused and nothing is written', async () => {
    const cases: [string, (s: FakeState) => void, RegExp][] = [
      [
        'a second policy on the app',
        (s) => s.apps[0].policies.push({ id: 'theirs' }),
        /policies other than the one setup recorded/,
      ],
      [
        'a require rule',
        (s) => (s.policies[0].require = [{ email_domain: { domain: 'acme.dev' } }]),
        /not a plain allow policy/,
      ],
      [
        'a service token rule',
        (s) => s.policies[0].include.push({ any_valid_service_token: {} }),
        /not a plain allow policy/,
      ],
      ['a block decision', (s) => (s.policies[0].decision = 'deny'), /not a plain allow policy/],
      ['another domain', (s) => (s.apps[0].domain = 'other.acme.dev'), /covers other.acme.dev/],
      ['another login method', (s) => (s.apps[0].allowed_idps = []), /login methods other than the one-time PIN/],
      [
        'a bypass not for everyone',
        (s) => (s.policies[1].include = [{ email_domain: { domain: 'acme.dev' } }]),
        /not a single bypass-everyone/,
      ],
      ['a bypass on another path', (s) => (s.apps[1].domain = 'specs.acme.dev/*'), /covers specs.acme.dev\/\*/],
      [
        'a bypass with a second destination',
        (s) => s.apps[1].destinations?.push({ type: 'public', uri: 'specs.acme.dev/*' }),
        /not only specs.acme.dev\/_publish\/\*/,
      ],
      [
        'the main app on a second hostname',
        (s) => s.apps[0].destinations?.push({ type: 'public', uri: 'old.acme.dev' }),
        /not only specs.acme.dev/,
      ],
      [
        'the allow policy shared with another app',
        (s) => s.apps.push({ ...s.apps[0], id: 'other', domain: 'other.acme.dev', aud: 'o' }),
        /used by one app/,
      ],
      [
        'the PIN login deleted and the app open to every method',
        (s) => {
          s.idps = [];
          s.apps[0].allowed_idps = [];
        },
        /login methods other than the one-time PIN/,
      ],
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

  it('17: resources with the wanted name but no recorded id are refused, not adopted, saying how to adopt one', async () => {
    const state = emptyAccount();
    state.d1.push({ uuid: 'someone-elses', name: 'specreview' });
    state.r2.push({ name: 'specreview-sites' });
    state.policies.push({ id: 'p', name: 'specreview specs.acme.dev', decision: 'allow', include: [] });
    state.apps.push({ id: 'theirs', domain: 'specs.acme.dev', type: 'self_hosted', aud: 'a', name: 'x', policies: [] });
    const r = await run(state, { apply: true });
    const found = [
      /D1 database named specreview/,
      /R2 bucket named specreview-sites/,
      /Access policy named "specreview specs.acme.dev"/,
      /Access app for specs.acme.dev exists/,
    ];
    for (const what of found) expect(r.error?.message).toMatch(what);
    expect(r.error?.message).toMatch(/add its id to hub.json and rerun/);
    expect(r.writes()).toEqual([]);
  });

  it('18: a run that fails part way records what it made, and the rerun makes only the rest', async () => {
    const state = emptyAccount();
    const first = await run(state, {
      apply: true,
      fake: { failOn: (q) => q.method === 'POST' && q.path.endsWith('/r2/buckets') },
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
      '/access/policies',
      '/access/policies',
      '/access/apps',
      '/access/apps',
    ]);
  });

  it("21: hub.json's audience differing from the app's is refused", async () => {
    const { state, dir } = await applied();
    state.apps[0].aud = 'recreated';
    const r = await run(state, { apply: true, dir });
    expect(r.error?.message).toMatch(/different audience/);
  });

  it('22: an existing one-time PIN login is reused; other login methods are left alone; rules are email only', async () => {
    const state = emptyAccount();
    state.idps.push({ id: 'google', type: 'google' }, { id: 'otp-1', type: 'onetimepin' });
    const r = await run(state, { apply: true });
    expect(r.error).toBeNull();
    expect(r.writes().some((w) => w.path.includes('identity_providers'))).toBe(false);
    expect(state.idps.map((p) => p.id)).toEqual(['google', 'otp-1']);
    expect(state.apps[0].allowed_idps).toEqual(['otp-1']);
    const kinds = new Set(state.policies[0].include.flatMap((rule) => Object.keys(rule as object)));
    expect([...kinds].sort()).toEqual(['email', 'email_domain']);
  });

  it('23: lists are read to the last page, with or without a page count, and R2 by cursor', async () => {
    const fill = () => {
      const state = emptyAccount();
      for (let i = 0; i < 60; i++) {
        state.apps.push({
          id: `filler-${i}`,
          domain: `x${i}.acme.dev`,
          type: 'self_hosted',
          aud: 'a',
          name: 'f',
          policies: [],
        });
      }
      state.apps.push({
        id: 'late',
        domain: 'specs.acme.dev',
        type: 'self_hosted',
        aud: 'a',
        name: 'theirs',
        policies: [],
      });
      for (let i = 0; i < 4; i++) state.zones.unshift({ id: `zz${i}`, name: `other${i}.dev`, status: 'active' });
      for (let i = 0; i < 4; i++) state.r2.push({ name: `specreview-sites-old${i}` });
      state.r2.push({ name: 'specreview-sites' });
      return state;
    };
    for (const noPageCount of [false, true]) {
      const r = await run(fill(), { apply: true, fake: { noPageCount } });
      expect(r.error?.message, String(noPageCount)).toMatch(/Access app for specs.acme.dev exists but is not recorded/);
      expect(r.error?.message, String(noPageCount)).toMatch(/R2 bucket named specreview-sites exists/);
      expect(r.error?.message, String(noPageCount)).not.toMatch(/no zone/);
    }
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

  it('adopting an app by its id records its audience, and deploy can proceed', async () => {
    const { state, dir } = await applied();
    const file = path.join(dir.dir, 'hub.json');
    const hub = JSON.parse(readFileSync(file, 'utf8')) as HubJson;
    delete hub.access?.aud;
    writeFileSync(file, JSON.stringify(hub));
    const r = await run(state, { apply: true, dir });
    expect(r.error).toBeNull();
    expect(r.hubJson.access?.aud).toBe(state.apps[0].aud);
    expect(r.writes()).toEqual([]);
  });

  it('a bucket found unrecorded says to set bucket.created', async () => {
    const state = emptyAccount();
    state.r2.push({ name: 'specreview-sites' });
    const r = await run(state, { apply: true });
    expect(r.error?.message).toMatch(
      /R2 bucket named specreview-sites exists .* set bucket.created to true in hub.json/,
    );
  });

  it('a list that ignores the page parameter is refused rather than looped', async () => {
    const state = emptyAccount();
    for (let i = 0; i < 60; i++) {
      state.apps.push({
        id: `filler-${i}`,
        domain: `x${i}.acme.dev`,
        type: 'self_hosted',
        aud: 'a',
        name: 'f',
        policies: [],
      });
    }
    const r = await run(state, { apply: true, fake: { noPageCount: true, ignorePage: true } });
    expect(r.error?.message).toMatch(/returned the same page twice/);
    expect(r.writes()).toEqual([]);
  });

  it('6: the token goes only in the authorization header and never into output', async () => {
    const r = await run(emptyAccount(), { apply: true });
    expect(new Set(r.requests.map((q) => q.auth))).toEqual(new Set([`Bearer ${TOKEN}`]));
    expect(r.lines.join('\n')).not.toContain(TOKEN);
    expect(r.requests.some((q) => q.path.includes(TOKEN) || JSON.stringify(q.body ?? '').includes(TOKEN))).toBe(false);
  });

  it('2: a config the hub would refuse stops setup before any call', async () => {
    const config = structuredClone(CONFIG);
    config.sites[0].approvers = ['@gmail.com'];
    const r = await run(emptyAccount(), { apply: true, config });
    expect(r.error?.message).toMatch(/approvers\[0\] is a public mail domain/);
    expect(r.requests).toEqual([]);
  });

  it('wantedInclude merges team domains, readers and admins without duplicates', () => {
    const config = structuredClone(CONFIG);
    config.sites.push({ ...config.sites[0], repo: 'web', readers: ['@initech.example'] });
    expect(wantedInclude(config)).toEqual(WANT);
  });
});

describe('33: a brand in the config', () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png body')]);

  it('a logo file name passes setup, which checks the config as the Worker will read it', async () => {
    const dir = orgDir(BARE_HUB, { ...CONFIG, brand: { name: 'Acme', logo: 'logo.png' } });
    writeFileSync(path.join(dir.dir, 'logo.png'), PNG);
    const r = await run(emptyAccount(), { dir });
    expect(r.error).toBeNull();
  });

  it('a broken logo or name stops setup before any write', async () => {
    for (const brand of [{ name: 'Acme', logo: 'logo.svg' }, { name: '' }]) {
      const r = await run(emptyAccount(), { config: { ...CONFIG, brand } });
      expect(r.error?.message, JSON.stringify(brand)).toMatch(/brand/);
      expect(r.writes()).toEqual([]);
    }
  });
});

describe('20: public sites in Access', () => {
  const HOST = 'specs.acme.dev';
  // Two sites; `pub` lists which are public.
  const configWith = (pub: string[]) => ({
    ...CONFIG,
    sites: ['sidecar', 'web'].map((repo, i) => ({
      ...CONFIG.sites[0],
      repo,
      repositoryId: String(2001 + i),
      ...(pub.includes(repo) ? { visibility: 'public' } : {}),
    })),
  });
  const protectedOf = (repo: string) => [
    `${HOST}/${repo}/_api/*`,
    `${HOST}/${repo}/_history/*`,
    `${HOST}/${repo}/_signin`,
  ];
  const covered = (state: FakeState, id: string | undefined) =>
    [...(state.apps.find((x) => x.id === id)?.destinations ?? []).map((d) => d.uri)].sort();
  const setPublic = (dir: ReturnType<typeof orgDir>, pub: string[]) =>
    writeFileSync(path.join(dir.dir, 'specreview.config.json'), JSON.stringify(configWith(pub)));
  // A hub set up with both sites private.
  const privateHub = async () => {
    const state = emptyAccount();
    const dir = orgDir(BARE_HUB, configWith([]));
    const first = await run(state, { apply: true, dir });
    expect(first.error).toBeNull();
    return { state, dir };
  };

  it('14: no public site: the main app covers the hostname only; no bypass app or policy', async () => {
    const { state, dir } = await privateHub();
    const hub = JSON.parse(readFileSync(path.join(dir.dir, 'hub.json'), 'utf8')) as HubJson;
    expect(covered(state, hub.access?.appId)).toEqual([HOST]);
    expect(hub.access?.publicAppId).toBeUndefined();
    expect(state.apps.some((x) => x.name === `specreview ${HOST} public`)).toBe(false);
  });

  it('19 (#56): the admin paths stay behind the main app; no bypass covers them, with or without a public site', async () => {
    const { state, dir } = await privateHub();
    setPublic(dir, ['sidecar']);
    expect((await run(state, { apply: true, dir })).error).toBeNull();
    const hub = JSON.parse(readFileSync(path.join(dir.dir, 'hub.json'), 'utf8')) as HubJson;
    expect(covered(state, hub.access?.appId)).toContain(HOST);
    // An Access destination ending in /* covers everything under it.
    const matches = (uri: string, target: string) =>
      uri.endsWith('/*') ? target.startsWith(uri.slice(0, -1)) : uri === target;
    const bypasses = state.apps
      .filter((x) => x.id !== hub.access?.appId)
      .flatMap((x) => [x.domain, ...(x.destinations ?? []).map((d) => d.uri)]);
    expect(bypasses.length).toBeGreaterThan(1);
    for (const target of [`${HOST}/_admin/`, `${HOST}/_admin/github/created`, `${HOST}/_admin/github/forget`]) {
      expect(bypasses.filter((uri) => matches(uri, target))).toEqual([]);
    }
  });

  it('15, 20: the first public site: plan writes nothing, then apply creates the bypass and grows the main app', async () => {
    const { state, dir } = await privateHub();
    setPublic(dir, ['sidecar']);
    const plan = await run(state, { dir });
    expect(plan.error).toBeNull();
    expect(plan.writes()).toEqual([]);
    expect(plan.lines.some((l) => l.includes(`Access bypass for ${HOST}/sidecar/*: create`))).toBe(true);
    const r = await run(state, { apply: true, dir });
    expect(r.error).toBeNull();
    expect(covered(state, r.hubJson.access?.appId)).toEqual([HOST, ...protectedOf('sidecar')].sort());
    expect(covered(state, r.hubJson.access?.publicAppId)).toEqual([`${HOST}/sidecar/*`]);
    const policy = state.policies.find((x) => x.id === r.hubJson.access?.publicPolicyId);
    expect(policy?.decision).toBe('bypass');
    // The main app's audience is the one the hub trusts, unchanged.
    expect(state.apps.find((x) => x.id === r.hubJson.access?.appId)?.aud).toBe(r.hubJson.access?.aud);
  });

  it('16: a second site turns public, then the first turns private: destinations follow exactly', async () => {
    const { state, dir } = await privateHub();
    setPublic(dir, ['sidecar']);
    await run(state, { apply: true, dir });
    setPublic(dir, ['sidecar', 'web']);
    const both = await run(state, { apply: true, dir });
    expect(covered(state, both.hubJson.access?.publicAppId)).toEqual([`${HOST}/sidecar/*`, `${HOST}/web/*`]);
    expect(covered(state, both.hubJson.access?.appId)).toEqual(
      [HOST, ...protectedOf('sidecar'), ...protectedOf('web')].sort(),
    );
    setPublic(dir, ['web']);
    const web = await run(state, { apply: true, dir });
    expect(covered(state, web.hubJson.access?.publicAppId)).toEqual([`${HOST}/web/*`]);
    expect(covered(state, web.hubJson.access?.appId)).toEqual([HOST, ...protectedOf('web')].sort());
  });

  it('16: the main app grows before the bypass changes and shrinks after it', async () => {
    const { state, dir } = await privateHub();
    setPublic(dir, ['sidecar']);
    const on = await run(state, { apply: true, dir });
    const onOrder = on.writes().map((w) => `${w.method} ${w.path.replace(`/accounts/${ACCOUNT}`, '')}`);
    const grow = onOrder.findIndex((w) => w.startsWith(`PUT /access/apps/${on.hubJson.access?.appId}`));
    const create = onOrder.findIndex((w) => w === 'POST /access/apps');
    expect(grow).toBeGreaterThanOrEqual(0);
    expect(grow).toBeLessThan(create);
    setPublic(dir, []);
    const off = await run(state, { apply: true, dir });
    const offOrder = off.writes().map((w) => `${w.method} ${w.path.replace(`/accounts/${ACCOUNT}`, '')}`);
    const del = offOrder.findIndex((w) => w.startsWith('DELETE /access/apps/'));
    const shrink = offOrder.findIndex((w) => w.startsWith(`PUT /access/apps/${on.hubJson.access?.appId}`));
    expect(del).toBeGreaterThanOrEqual(0);
    expect(del).toBeLessThan(shrink);
  });

  it('17: the last public site turns private: bypass app and policy deleted, main app back to the hostname', async () => {
    const { state, dir } = await privateHub();
    setPublic(dir, ['sidecar']);
    const on = await run(state, { apply: true, dir });
    setPublic(dir, []);
    const off = await run(state, { apply: true, dir });
    expect(off.error).toBeNull();
    expect(off.hubJson.access?.publicAppId).toBeUndefined();
    expect(off.hubJson.access?.publicPolicyId).toBeUndefined();
    expect(state.apps.some((x) => x.id === on.hubJson.access?.publicAppId)).toBe(false);
    expect(state.policies.some((x) => x.id === on.hubJson.access?.publicPolicyId)).toBe(false);
    expect(covered(state, off.hubJson.access?.appId)).toEqual([HOST]);
    const again = await run(state, { dir });
    expect(again.lines).toContain('nothing to do');
  });

  it('18: the main app covering another path is refused', async () => {
    const { state, dir } = await privateHub();
    const hub = JSON.parse(readFileSync(path.join(dir.dir, 'hub.json'), 'utf8')) as HubJson;
    state.apps.find((x) => x.id === hub.access?.appId)!.destinations!.push({ type: 'public', uri: `${HOST}/other/*` });
    const r = await run(state, { dir });
    expect(r.error?.message).toMatch(/not only specs\.acme\.dev and the public sites' protected paths/);
  });

  it('19: a bypass app or policy changed by hand is refused', async () => {
    const { state, dir } = await privateHub();
    setPublic(dir, ['sidecar']);
    const on = await run(state, { apply: true, dir });
    state.apps
      .find((x) => x.id === on.hubJson.access?.publicAppId)!
      .destinations!.push({ type: 'public', uri: `${HOST}/*` });
    expect((await run(state, { dir })).error?.message).toMatch(/not only public sites' pages/);
    state.apps.find((x) => x.id === on.hubJson.access?.publicAppId)!.destinations!.pop();
    state.policies.find((x) => x.id === on.hubJson.access?.publicPolicyId)!.decision = 'allow';
    expect((await run(state, { dir })).error?.message).toMatch(/not a single bypass-everyone rule/);
  });

  it('19a: a failure after the bypass policy is created resumes on the next run', async () => {
    const { state, dir } = await privateHub();
    setPublic(dir, ['sidecar']);
    const failed = await run(state, {
      apply: true,
      dir,
      fake: { failOn: (r) => r.method === 'POST' && r.path.endsWith('/access/apps') },
    });
    expect(failed.error).not.toBeNull();
    expect(failed.hubJson.access?.publicPolicyId).toBeDefined();
    const r = await run(state, { apply: true, dir });
    expect(r.error).toBeNull();
    expect(covered(state, r.hubJson.access?.publicAppId)).toEqual([`${HOST}/sidecar/*`]);
  });

  it('19b: a failure after the bypass app is deleted resumes on the next run', async () => {
    const { state, dir } = await privateHub();
    setPublic(dir, ['sidecar']);
    await run(state, { apply: true, dir });
    setPublic(dir, []);
    const failed = await run(state, {
      apply: true,
      dir,
      fake: { failOn: (r) => r.method === 'DELETE' && r.path.includes('/access/policies/') },
    });
    expect(failed.error).not.toBeNull();
    expect(failed.hubJson.access?.publicAppId).toBeUndefined();
    const r = await run(state, { apply: true, dir });
    expect(r.error).toBeNull();
    expect(r.hubJson.access?.publicPolicyId).toBeUndefined();
  });

  it('19b: a recorded bypass app that is gone (a delete whose answer was lost) is forgotten, not refused', async () => {
    const { state, dir } = await privateHub();
    setPublic(dir, ['sidecar']);
    const on = await run(state, { apply: true, dir });
    state.apps = state.apps.filter((x) => x.id !== on.hubJson.access?.publicAppId);
    const r = await run(state, { apply: true, dir });
    expect(r.error).toBeNull();
    expect(r.hubJson.access?.publicAppId).toBeDefined();
    expect(r.hubJson.access?.publicAppId).not.toBe(on.hubJson.access?.publicAppId);
  });

  it('review: removing a public site from the config cleans up after it, not refused', async () => {
    const { state, dir } = await privateHub();
    setPublic(dir, ['sidecar', 'web']);
    await run(state, { apply: true, dir });
    // web leaves the config entirely.
    const onlySidecar = configWith(['sidecar']);
    writeFileSync(
      path.join(dir.dir, 'specreview.config.json'),
      JSON.stringify({ ...onlySidecar, sites: onlySidecar.sites.slice(0, 1) }),
    );
    const r = await run(state, { apply: true, dir });
    expect(r.error).toBeNull();
    expect(covered(state, r.hubJson.access?.publicAppId)).toEqual([`${HOST}/sidecar/*`]);
    expect(covered(state, r.hubJson.access?.appId)).toEqual([HOST, ...protectedOf('sidecar')].sort());
  });

  it('review: updating the main app keeps its other settings', async () => {
    const { state, dir } = await privateHub();
    const hub = JSON.parse(readFileSync(path.join(dir.dir, 'hub.json'), 'utf8')) as HubJson;
    const app = state.apps.find((x) => x.id === hub.access?.appId) as unknown as Record<string, unknown>;
    app.session_duration = '8h';
    app.cors_headers = { allowed_origins: ['https://x.example'] };
    setPublic(dir, ['sidecar']);
    await run(state, { apply: true, dir });
    const after = state.apps.find((x) => x.id === hub.access?.appId) as unknown as Record<string, unknown>;
    expect(after.session_duration).toBe('8h');
    expect(after.cors_headers).toEqual({ allowed_origins: ['https://x.example'] });
    expect(after.aud).toBe(hub.access?.aud);
  });

  it('review: a bypass app covering a path setup never writes is refused', async () => {
    for (const stray of [`${HOST}/_publish/*`, `${HOST}/../*`, `${HOST}/./*`]) {
      const { state, dir } = await privateHub();
      setPublic(dir, ['sidecar']);
      const on = await run(state, { apply: true, dir });
      state.apps
        .find((x) => x.id === on.hubJson.access?.publicAppId)!
        .destinations!.push({ type: 'public', uri: stray });
      expect((await run(state, { dir })).error?.message, stray).toMatch(/not only public sites' pages/);
    }
  });

  it('review: a main app with a non-public destination is refused, not silently rewritten', async () => {
    const { state, dir } = await privateHub();
    const hub = JSON.parse(readFileSync(path.join(dir.dir, 'hub.json'), 'utf8')) as HubJson;
    state.apps.find((x) => x.id === hub.access?.appId)!.destinations!.push({ type: 'private', uri: '10.0.0.0/8' });
    setPublic(dir, ['sidecar']);
    const r = await run(state, { apply: true, dir });
    expect(r.error?.message).toMatch(/not only specs\.acme\.dev/);
  });

  it('review: a recorded bypass policy that is gone, with a same-name stray in its place, is refused', async () => {
    const { state, dir } = await privateHub();
    setPublic(dir, ['sidecar']);
    const on = await run(state, { apply: true, dir });
    state.apps = state.apps.filter((x) => x.id !== on.hubJson.access?.publicAppId);
    state.policies = state.policies.filter((x) => x.id !== on.hubJson.access?.publicPolicyId);
    state.policies.push({
      id: 'pol-stray',
      name: `specreview ${HOST} public`,
      decision: 'bypass',
      include: [{ everyone: {} }],
    });
    const r = await run(state, { apply: true, dir });
    expect(r.error?.message).toMatch(/specreview specs\.acme\.dev public/);
    expect(r.writes()).toEqual([]);
  });

  it('review: a bypass app left pointing at a deleted policy is repointed at the new one', async () => {
    const { state, dir } = await privateHub();
    setPublic(dir, ['sidecar']);
    const on = await run(state, { apply: true, dir });
    state.policies = state.policies.filter((x) => x.id !== on.hubJson.access?.publicPolicyId);
    const r = await run(state, { apply: true, dir });
    expect(r.error).toBeNull();
    const after = state.apps.find((x) => x.id === r.hubJson.access?.publicAppId)!;
    expect(r.hubJson.access?.publicPolicyId).not.toBe(on.hubJson.access?.publicPolicyId);
    expect(after.policies.map((x) => x.id)).toEqual([r.hubJson.access?.publicPolicyId]);
  });

  it("19c: an unrecorded bypass app or policy with setup's name is refused, public or not", async () => {
    for (const pub of [[], ['sidecar']]) {
      const { state, dir } = await privateHub();
      state.policies.push({
        id: 'pol-stray',
        name: `specreview ${HOST} public`,
        decision: 'bypass',
        include: [{ everyone: {} }],
      });
      setPublic(dir, pub);
      const r = await run(state, { apply: true, dir });
      expect(r.error?.message, JSON.stringify(pub)).toMatch(/specreview specs\.acme\.dev public/);
    }
  });
});

describe('#75: the admin hostname in Access', () => {
  const ADMIN_HOST = 'specs-admin.acme.dev';
  const withAdmin = (dir: { dir: string }) => {
    const file = path.join(dir.dir, 'hub.json');
    const hub = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...hub, adminHostname: ADMIN_HOST }));
  };
  const ADMINS = [{ email: { email: 'owner@acme.dev' } }];

  it('11: an existing hub gaining it gets only an admins policy and an app for it; nothing else changes', async () => {
    const { state, dir, hub: before } = await applied();
    const othersBefore = structuredClone({ apps: state.apps, policies: state.policies });
    withAdmin(dir);
    const r = await run(state, { apply: true, dir });
    expect(r.error).toBeNull();
    expect(r.writes().map((w) => [w.method, w.path.replace(`/accounts/${ACCOUNT}`, '')])).toEqual([
      ['POST', '/access/policies'],
      ['POST', '/access/apps'],
    ]);
    const policy = state.policies.find((p) => p.id === r.hubJson.access?.adminPolicyId)!;
    expect([policy.name, policy.decision, policy.include]).toEqual([
      `specreview ${ADMIN_HOST} admins`,
      'allow',
      ADMINS,
    ]);
    const app = state.apps.find((x) => x.id === r.hubJson.access?.adminAppId)!;
    expect([app.domain, app.policies.map((p) => p.id), app.allowed_idps, app.aud]).toEqual([
      ADMIN_HOST,
      [policy.id],
      [state.idps[0].id],
      r.hubJson.access?.adminAud,
    ]);
    // The main, publish and any other resources and ids are as they were.
    expect(state.apps.filter((x) => x.id !== app.id)).toEqual(othersBefore.apps);
    expect(state.policies.filter((p) => p.id !== policy.id)).toEqual(othersBefore.policies);
    const { adminPolicyId: _p, adminAppId: _a, adminAud: _d, ...restAccess } = r.hubJson.access ?? {};
    expect(restAccess).toEqual(before.access);
    expect(r.lines.at(-1)).toBe('hub.json updated; commit it');
    const again = await run(state, { apply: true, dir });
    expect(again.writes()).toEqual([]);
    expect(again.lines.at(-1)).toBe('nothing to do');
  });

  it('11: the admins policy follows the config; the main policy keeps its own list', async () => {
    const { state, dir } = await applied();
    withAdmin(dir);
    await run(state, { apply: true, dir });
    const config = structuredClone(CONFIG);
    config.admins = ['boss@acme.dev', 'owner@acme.dev'];
    writeFileSync(path.join(dir.dir, 'specreview.config.json'), JSON.stringify(config));
    const r = await run(state, { apply: true, dir });
    expect(r.error).toBeNull();
    const adminPolicy = state.policies.find((p) => p.id === r.hubJson.access?.adminPolicyId)!;
    expect(adminPolicy.include).toEqual([
      { email: { email: 'boss@acme.dev' } },
      { email: { email: 'owner@acme.dev' } },
    ]);
  });

  it('11: a conflict on the admin hostname is refused before anything is created', async () => {
    const cases: [string, (s: FakeState) => void, RegExp][] = [
      [
        'a DNS record',
        (s) => s.dns.z1.push({ name: ADMIN_HOST }),
        new RegExp(`${ADMIN_HOST} already has a DNS record`),
      ],
      [
        'another Worker',
        (s) => s.workerDomains.push({ hostname: ADMIN_HOST, service: 'their-worker' }),
        /custom domain of Worker their-worker/,
      ],
      ['no zone', (s) => s.zones.push({ id: 'z2', name: 'other.dev', status: 'active' }), /no zone/],
    ];
    for (const [name, change, why] of cases) {
      const { state, dir } = await applied();
      const host = name === 'no zone' ? 'admin.other-zone.example' : ADMIN_HOST;
      const file = path.join(dir.dir, 'hub.json');
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), adminHostname: host }));
      change(state);
      const r = await run(state, { apply: true, dir });
      expect(r.error?.message, name).toMatch(why);
      expect(r.writes(), name).toEqual([]);
    }
  });

  it('11: an admin app that lets other origins read it, or another app already on the hostname, is refused', async () => {
    const { state, dir } = await applied();
    withAdmin(dir);
    const first = await run(state, { apply: true, dir });
    const app = state.apps.find((x) => x.id === first.hubJson.access?.adminAppId)!;
    for (const [setting, value] of [
      ['cors_headers', { allowed_origins: ['https://specs.acme.dev'] }],
      ['cors_headers', { allow_all_origins: true }],
      ['options_preflight_bypass', true],
    ] as const) {
      (app as Record<string, unknown>)[setting] = value;
      const r = await run(state, { apply: true, dir });
      expect(r.error?.message, setting).toMatch(/lets other origins read it/);
      expect(r.writes()).toEqual([]);
      delete (app as Record<string, unknown>)[setting];
    }
    const fresh = await applied();
    fresh.state.apps.push({
      id: 'theirs',
      domain: ADMIN_HOST,
      type: 'self_hosted',
      aud: 'x',
      name: 'theirs',
      policies: [],
    });
    withAdmin(fresh.dir);
    const r = await run(fresh.state, { apply: true, dir: fresh.dir });
    expect(r.error?.message).toMatch(new RegExp(`an Access app for ${ADMIN_HOST}`));
  });

  it('11: an admin app or admins policy changed by hand is refused, and nothing is written', async () => {
    const edits: [string, (s: FakeState, ids: Record<string, string>) => void, RegExp][] = [
      [
        'another audience',
        (s, ids) => (s.apps.find((x) => x.id === ids.adminAppId)!.aud = 'aud-other'),
        /different audience/,
      ],
      [
        'another policy',
        (s, ids) => s.apps.find((x) => x.id === ids.adminAppId)!.policies.push({ id: 'pol-other' }),
        /policies other than the one setup recorded/,
      ],
      [
        'another login method',
        (s, ids) => (s.apps.find((x) => x.id === ids.adminAppId)!.allowed_idps = ['idp-other']),
        /login methods other than the one-time PIN/,
      ],
      [
        'more than the hostname',
        (s, ids) =>
          s.apps.find((x) => x.id === ids.adminAppId)!.destinations!.push({ type: 'public', uri: 'specs.acme.dev' }),
        /not only specs-admin.acme.dev/,
      ],
      [
        'the policy on another app',
        (s, ids) => s.apps.find((x) => x.domain === 'specs.acme.dev')!.policies.push({ id: ids.adminPolicyId }),
        /not a plain allow policy/,
      ],
      [
        'a require rule',
        (s, ids) =>
          (s.policies.find((p) => p.id === ids.adminPolicyId)!.require = [{ email: { email: 'x@acme.dev' } }]),
        /not a plain allow policy/,
      ],
      [
        'a non-email rule',
        (s, ids) => s.policies.find((p) => p.id === ids.adminPolicyId)!.include.push({ everyone: {} }),
        /not a plain allow policy/,
      ],
    ];
    for (const [name, edit, why] of edits) {
      const { state, dir } = await applied();
      withAdmin(dir);
      const on = await run(state, { apply: true, dir });
      const ids = on.hubJson.access as Record<string, string>;
      for (const app of state.apps) app.self_hosted_domains = app.destinations?.map((d) => d.uri);
      edit(state, ids);
      for (const app of state.apps) app.self_hosted_domains = app.destinations?.map((d) => d.uri);
      const r = await run(state, { apply: true, dir });
      expect(r.error?.message, name).toMatch(why);
      expect(r.writes(), name).toEqual([]);
    }
  });

  it('11: removal is refused while the admin app or policy is no longer only ours', async () => {
    for (const share of ['app covers more', 'policy shared'] as const) {
      const { state, dir } = await applied();
      withAdmin(dir);
      const on = await run(state, { apply: true, dir });
      const ids = on.hubJson.access as Record<string, string>;
      if (share === 'app covers more') {
        const app = state.apps.find((x) => x.id === ids.adminAppId)!;
        app.destinations!.push({ type: 'public', uri: 'other.acme.dev' });
        app.self_hosted_domains = app.destinations!.map((d) => d.uri);
      } else state.apps.find((x) => x.domain === 'specs.acme.dev')!.policies.push({ id: ids.adminPolicyId });
      const file = path.join(dir.dir, 'hub.json');
      const { adminHostname: _x, ...without } = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      writeFileSync(file, JSON.stringify(without));
      const r = await run(state, { apply: true, dir });
      expect(r.error?.message, share).toMatch(/setup will not delete it/);
      expect(r.writes(), share).toEqual([]);
    }
  });

  it('11: removing the admin hostname deletes its app and policy and forgets them', async () => {
    const { state, dir } = await applied();
    withAdmin(dir);
    const on = await run(state, { apply: true, dir });
    const { adminAppId, adminPolicyId } = on.hubJson.access ?? {};
    const file = path.join(dir.dir, 'hub.json');
    const { adminHostname: _x, ...without } = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify(without));
    const others = structuredClone({
      apps: state.apps.filter((x) => x.id !== adminAppId),
      policies: state.policies.filter((p) => p.id !== adminPolicyId),
    });
    const r = await run(state, { apply: true, dir });
    expect(r.error).toBeNull();
    expect({ apps: state.apps, policies: state.policies }).toEqual(others);
    expect(state.apps.some((x) => x.id === adminAppId)).toBe(false);
    expect(state.policies.some((p) => p.id === adminPolicyId)).toBe(false);
    expect([r.hubJson.access?.adminAppId, r.hubJson.access?.adminPolicyId, r.hubJson.access?.adminAud]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe('#78: apps setup did not make, and settings it keeps', () => {
  const ADMIN_HOST = 'specs-admin.acme.dev';
  const stranger = (
    id: string,
    cover: { domain: string; destinations?: string[]; self_hosted_domains?: string[] },
  ) => ({
    id,
    name: `someone's ${id}`,
    domain: cover.domain,
    type: 'self_hosted',
    aud: `aud-${id}`,
    policies: [],
    allowed_idps: [],
    ...(cover.destinations ? { destinations: cover.destinations.map((uri) => ({ type: 'public', uri })) } : {}),
    ...(cover.self_hosted_domains ? { self_hosted_domains: cover.self_hosted_domains } : {}),
  });
  const withAdmin = (dir: { dir: string }) => {
    const file = path.join(dir.dir, 'hub.json');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), adminHostname: ADMIN_HOST }));
  };

  it.each([
    [
      '12: the hostname only in its destinations',
      stranger('x1', { domain: 'tools.acme.dev', destinations: ['tools.acme.dev', 'specs.acme.dev'] }),
      /covers specs\.acme\.dev and/,
    ],
    [
      '13: a bypass over one site',
      {
        ...stranger('x2', { domain: 'specs.acme.dev/sidecar/*', destinations: ['specs.acme.dev/sidecar/*'] }),
        type: 'bypass',
      },
      /covers specs\.acme\.dev\/sidecar\/\* and/,
    ],
    [
      '14: the admin hostname through self_hosted_domains',
      stranger('x3', { domain: 'tools.acme.dev', self_hosted_domains: ['tools.acme.dev', ADMIN_HOST] }),
      /covers specs-admin\.acme\.dev and/,
    ],
  ])('%s is refused, and nothing is written', async (_name, app, why) => {
    const { state, dir } = await applied();
    withAdmin(dir);
    expect((await run(state, { apply: true, dir })).error).toBeNull();
    state.apps.push(app as (typeof state.apps)[number]);
    const r = await run(state, { apply: true, dir });
    expect(r.error?.message).toMatch(/stopped before changing anything/);
    expect(r.error?.message).toMatch(why);
    expect(r.error?.message).toMatch(/is not recorded in hub\.json; it could open or shadow part of the hub/);
    expect(r.writes()).toEqual([]);
  });

  it.each([
    [
      'a wildcard host with a path under it',
      '*.acme.dev/sidecar/_api/*',
      /covers \*\.acme\.dev\/sidecar\/_api\/\* and/,
    ],
    ['the hostname in capitals', 'SPECS.acme.dev/sidecar/*', /covers SPECS\.acme\.dev\/sidecar\/\* and/],
    ['the hostname followed by a wildcard', 'specs.acme.dev*', /covers specs\.acme\.dev\* and/],
  ])('13a: %s is refused', async (_name, uri, why) => {
    const { state, dir } = await applied();
    state.apps.push(stranger('w1', { domain: uri, destinations: [uri] }) as (typeof state.apps)[number]);
    const r = await run(state, { apply: true, dir });
    expect(r.error?.message).toMatch(why);
    expect(r.writes()).toEqual([]);
  });

  it("13b: an app named like the hub's public bypass is refused while the real one is recorded", async () => {
    const { state, dir } = await applied();
    const config = { ...CONFIG, sites: CONFIG.sites.map((x, i) => (i === 0 ? { ...x, visibility: 'public' } : x)) };
    writeFileSync(path.join(dir.dir, 'specreview.config.json'), JSON.stringify(config));
    expect((await run(state, { apply: true, dir, config })).error).toBeNull();
    const repo = CONFIG.sites[0].repo;
    state.apps.push({
      ...stranger('n1', { domain: `specs.acme.dev/${repo}/_api/*`, destinations: [`specs.acme.dev/${repo}/_api/*`] }),
      name: 'specreview specs.acme.dev public',
      type: 'bypass',
    } as (typeof state.apps)[number]);
    const r = await run(state, { apply: true, dir, config });
    expect(r.error?.message).toMatch(/Access app n1 \("specreview specs\.acme\.dev public"\) covers/);
    expect(r.writes()).toEqual([]);
  });

  it('15: apps over other hostnames, sibling names, and stale self_hosted_domains under destinations are left alone', async () => {
    const { state, dir } = await applied();
    state.apps.push(
      stranger('y1', { domain: 'specs.acme.devx', destinations: ['specs.acme.devx'] }) as (typeof state.apps)[number],
      stranger('y2', {
        domain: 'specs.acme.dev.example',
        destinations: ['specs.acme.dev.example/x'],
      }) as (typeof state.apps)[number],
      stranger('y3', {
        domain: 'tools.acme.dev',
        destinations: ['tools.acme.dev'],
        self_hosted_domains: ['specs.acme.dev'],
      }) as (typeof state.apps)[number],
      // A company-wide app over every subdomain: the hub's own app is more specific.
      stranger('y4', { domain: '*.acme.dev', destinations: ['*.acme.dev'] }) as (typeof state.apps)[number],
      // A bookmark lists a link and protects nothing.
      { ...stranger('y5', { domain: 'specs.acme.dev' }), type: 'bookmark' } as (typeof state.apps)[number],
    );
    const r = await run(state, { apply: true, dir });
    expect(r.error).toBeNull();
    expect(r.lines.at(-1)).toBe('nothing to do');
  });

  it("16: the hostname's app with CORS, preflight bypass or framing is noted, not refused", async () => {
    const { state, dir } = await applied();
    const main = state.apps[0];
    main.cors_headers = { allowed_origins: ['https://elsewhere.example'] };
    main.options_preflight_bypass = true;
    main.allow_iframe = true;
    const r = await run(state, { apply: true, dir });
    expect(r.error).toBeNull();
    expect(r.lines).toContain(
      'Access app for specs.acme.dev: note, it has CORS allowing other origins, preflight bypass, framing allowed; setup keeps these as they are',
    );
    expect(r.writes()).toEqual([]);
  });

  it("16: sign-in through a WARP session is refused on the hostname's app and the admin app", async () => {
    const { state, dir } = await applied();
    withAdmin(dir);
    expect((await run(state, { apply: true, dir })).error).toBeNull();
    for (const which of ['main', 'admin'] as const) {
      const hub = JSON.parse(readFileSync(path.join(dir.dir, 'hub.json'), 'utf8')) as HubJson;
      const id = which === 'main' ? hub.access?.appId : hub.access?.adminAppId;
      const app = state.apps.find((x) => x.id === id)!;
      app.allow_authenticate_via_warp = true;
      const r = await run(state, { apply: true, dir });
      expect(r.error?.message, which).toMatch(new RegExp(`Access app ${id} allows sign-in through a WARP session`));
      expect(r.writes(), which).toEqual([]);
      delete app.allow_authenticate_via_warp;
    }
  });
});

describe('#91: who passes Access', () => {
  it('7: named team members and approvers anywhere sign in; emails a domain rule covers are left out; no team key is fine', () => {
    const config = structuredClone(CONFIG) as unknown as { sites: Record<string, unknown>[] };
    expect(wantedInclude(config as unknown as Record<string, unknown>)).toEqual(WANT);
    config.sites[0] = {
      ...config.sites[0],
      team: ['manish@ariai.example', 'dev@acme.dev'],
      approvers: ['pm@acme.dev', 'boss@elsewhere.example', '@leads.example', 'kim@leads.example'],
    };
    expect(wantedInclude(config as unknown as Record<string, unknown>)).toEqual(
      [
        ...WANT,
        { email: { email: 'manish@ariai.example' } },
        { email: { email: 'boss@elsewhere.example' } },
        { email_domain: { domain: 'leads.example' } },
      ].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)),
    );
  });
});
