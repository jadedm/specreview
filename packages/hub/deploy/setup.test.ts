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
    const r = await run(state, { apply: true, dir });
    expect(r.error).toBeNull();
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
        (s) => s.apps[0].self_hosted_domains?.push('old.acme.dev'),
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
    config.sites[0].approvers = ['pm@elsewhere.dev'];
    const r = await run(emptyAccount(), { apply: true, config });
    expect(r.error?.message).toMatch(/approvers has an email outside the team domains/);
    expect(r.requests).toEqual([]);
  });

  it('wantedInclude merges team domains, readers and admins without duplicates', () => {
    const config = structuredClone(CONFIG);
    config.sites.push({ ...config.sites[0], repo: 'web', readers: ['@initech.example'] });
    expect(wantedInclude(config)).toEqual(WANT);
  });
});
