// One organisation's Cloudflare resources: a D1 database, an R2 bucket, the
// one-time PIN login, an Access application for the hostname and an Access
// bypass for /_publish/*. Everything is read first; anything that would have
// to be refused stops the run before a single resource is created. Resources
// are tracked by the ids setup records in hub.json, never adopted by name: a
// database or app with the right name but no recorded id may belong to
// someone else.
import { problemsIn } from '../src/config';
import { CloudflareError, type Cloudflare } from './cloudflare';
import { DeployError, saveHub, type Org } from './org';

type Rule = { email?: { email: string }; email_domain?: { domain: string }; everyone?: Record<string, never> };
type Policy = {
  id: string;
  name?: string;
  decision?: string;
  include?: unknown[];
  exclude?: unknown[];
  require?: unknown[];
};
type App = { id: string; domain?: string; type?: string; aud?: string; name?: string };
type Zone = { id: string; name: string; status: string };

const POLICY = 'specreview';
const PUBLISH_POLICY = 'specreview publish';

const ruleKey = (r: unknown) => JSON.stringify(r);
// Code-point order, so the result is the same on every machine and locale.
const byKey = (a: unknown, b: unknown) => (ruleKey(a) < ruleKey(b) ? -1 : ruleKey(a) > ruleKey(b) ? 1 : 0);
const sortedRules = (rules: unknown[]) => [...new Map(rules.map((r) => [ruleKey(r), r])).values()].sort(byKey);

// Who may pass Access: everyone at a team domain, each reader (an email or a
// whole @domain), and each admin. Only email and email-domain rules: a
// login-method rule would admit anyone who can receive a code.
export const wantedInclude = (config: Record<string, unknown>): Rule[] => {
  const sites = (config.sites as { teamDomains: string[]; readers: string[] }[]) ?? [];
  const rules: Rule[] = [];
  for (const domain of sites.flatMap((s) => s.teamDomains)) rules.push({ email_domain: { domain } });
  for (const entry of sites.flatMap((s) => s.readers)) {
    rules.push(entry.startsWith('@') ? { email_domain: { domain: entry.slice(1) } } : { email: { email: entry } });
  }
  for (const email of (config.admins as string[]) ?? []) rules.push({ email: { email } });
  return sortedRules(rules) as Rule[];
};

const sameRules = (a: unknown[] | undefined, b: unknown[]) =>
  JSON.stringify(sortedRules(a ?? [])) === JSON.stringify(sortedRules(b));
const empty = (v: unknown[] | undefined) => v === undefined || v.length === 0;

type Step = { say: string; run?: () => Promise<void> };

export const setup = async (org: Org, cf: Cloudflare, opts: { apply: boolean; log: (line: string) => void }) => {
  const { hub } = org;
  const a = hub.accountId;
  const host = hub.hostname;
  const publishDomain = `${host}/_publish/*`;
  const log = opts.log;

  // The config must be sound before it decides who passes Access.
  const problems = problemsIn({ ...org.config, accessTeamDomain: 'check.cloudflareaccess.com', accessAud: 'check' });
  if (problems.length > 0) throw new DeployError(`specreview.config.json has problems:\n  ${problems.join('\n  ')}`);
  const include = wantedInclude(org.config);

  await cf.call(`GET`, `/accounts/${a}`).catch((e: unknown) => {
    throw new DeployError(`the token cannot read account ${a}: ${e instanceof Error ? e.message : String(e)}`);
  });
  const orgAccess = await cf
    .call<{ auth_domain: string }>('GET', `/accounts/${a}/access/organizations`)
    .catch((e: unknown) => {
      const off = e instanceof CloudflareError && e.errors.some((x) => /not[_ ]enabled/i.test(x.message ?? ''));
      throw new DeployError(
        off
          ? 'Zero Trust is not enabled on this account: enable Access in the dashboard first'
          : `could not read the Access organisation: ${e instanceof Error ? e.message : String(e)}`,
      );
    });

  const refusals: string[] = [];
  const steps: Step[] = [];

  // The hostname: its zone is in this account and active, and nothing else
  // serves it. A custom domain already on this Worker is a previous deploy.
  const zones = await cf.list<Zone>(`/zones?account.id=${a}`);
  const zone = zones
    .filter((z) => host === z.name || host.endsWith(`.${z.name}`))
    .sort((x, y) => y.name.length - x.name.length)[0];
  if (!zone) refusals.push(`no zone in account ${a} covers ${host}`);
  if (zone && zone.status !== 'active') refusals.push(`zone ${zone.name} is ${zone.status}, not active`);
  if (zone) {
    const domains = await cf.call<{ hostname: string; service: string }[]>(
      'GET',
      `/accounts/${a}/workers/domains?hostname=${host}`,
    );
    const mine = domains.some((d) => d.hostname === host && d.service === hub.worker);
    const other = domains.find((d) => d.hostname === host && d.service !== hub.worker);
    if (other) refusals.push(`${host} is already the custom domain of Worker ${other.service}`);
    const records = await cf.call<unknown[]>('GET', `/zones/${zone.id}/dns_records?name=${host}`);
    if (records.length > 0 && !mine)
      refusals.push(`${host} already has a DNS record; remove it or pick another hostname`);
    log(`hostname ${host}: zone ${zone.name} ${mine ? '(already served by this Worker)' : 'is free'}`);
  }

  // One-time PIN login: reused when present, never changed.
  const idps = await cf.list<{ id: string; type: string }>(`/accounts/${a}/access/identity_providers`);
  let otp = idps.find((p) => p.type === 'onetimepin')?.id;
  if (otp) log('one-time PIN login: exists');
  else
    steps.push({
      say: 'one-time PIN login: create',
      run: async () => {
        otp = (
          await cf.call<{ id: string }>('POST', `/accounts/${a}/access/identity_providers`, {
            name: 'One-time PIN login',
            type: 'onetimepin',
            config: {},
          })
        ).id;
      },
    });

  // D1.
  if (hub.database.id) {
    const db = await cf
      .call<{ name: string }>('GET', `/accounts/${a}/d1/database/${hub.database.id}`)
      .catch(() => null);
    if (!db) refusals.push(`D1 database ${hub.database.id} recorded in hub.json is not in the account`);
    else if (db.name !== hub.database.name)
      refusals.push(`D1 database ${hub.database.id} is named ${db.name}, not ${hub.database.name}`);
    else log(`D1 ${hub.database.name}: exists`);
  } else {
    const found = (await cf.list<{ name: string }>(`/accounts/${a}/d1/database?name=${hub.database.name}`)).some(
      (d) => d.name === hub.database.name,
    );
    if (found)
      refusals.push(
        `a D1 database named ${hub.database.name} exists but is not recorded in hub.json; it is not adopted`,
      );
    else
      steps.push({
        say: `D1 ${hub.database.name}: create`,
        run: async () => {
          hub.database.id = (
            await cf.call<{ uuid: string }>('POST', `/accounts/${a}/d1/database`, { name: hub.database.name })
          ).uuid;
          saveHub(org);
        },
      });
  }

  // R2.
  const buckets = await cf.call<{ buckets: { name: string }[] }>(
    'GET',
    `/accounts/${a}/r2/buckets?name_contains=${hub.bucket.name}&per_page=1000`,
  );
  const bucketThere = buckets.buckets.some((b) => b.name === hub.bucket.name);
  if (hub.bucket.created && !bucketThere)
    refusals.push(`R2 bucket ${hub.bucket.name} recorded in hub.json is not in the account`);
  else if (hub.bucket.created) log(`R2 ${hub.bucket.name}: exists`);
  else if (bucketThere)
    refusals.push(`an R2 bucket named ${hub.bucket.name} exists but is not recorded in hub.json; it is not adopted`);
  else
    steps.push({
      say: `R2 ${hub.bucket.name}: create`,
      run: async () => {
        await cf.call('POST', `/accounts/${a}/r2/buckets`, { name: hub.bucket.name });
        hub.bucket.created = true;
        saveHub(org);
      },
    });

  // Access applications.
  const apps = await cf.list<App>(`/accounts/${a}/access/apps`);
  const access = (hub.access ??= {});
  const policiesOf = (id: string) => cf.call<Policy[]>('GET', `/accounts/${a}/access/apps/${id}/policies`);

  if (access.appId) {
    const app = apps.find((x) => x.id === access.appId);
    const policies = app ? await policiesOf(app.id) : [];
    const ours = policies[0];
    const foreignRule = (ours?.include ?? []).some(
      (r) => typeof r !== 'object' || r === null || Object.keys(r).some((k) => k !== 'email' && k !== 'email_domain'),
    );
    if (!app) refusals.push(`Access app ${access.appId} recorded in hub.json is not in the account`);
    else if (app.domain !== host || app.type !== 'self_hosted')
      refusals.push(`Access app ${app.id} is for ${app.domain} (${app.type}), not ${host}; it was changed by hand`);
    else if (access.aud && app.aud !== access.aud)
      refusals.push(`Access app ${app.id}'s audience differs from hub.json; it was recreated or edited`);
    else if (policies.length !== 1 || ours.name !== POLICY || ours.decision !== 'allow')
      refusals.push(
        `Access app ${app.id} has policies other than the one "${POLICY}" allow policy; setup will not change it`,
      );
    else if (!empty(ours.require) || !empty(ours.exclude) || foreignRule)
      refusals.push(`Access app ${app.id}'s policy has require, exclude or non-email rules; setup will not change it`);
    else if (sameRules(ours.include, include)) log(`Access app for ${host}: policy up to date`);
    else {
      log(`policy before: ${JSON.stringify(sortedRules(ours.include ?? []))}`);
      log(`policy wanted: ${JSON.stringify(include)}`);
      steps.push({
        say: `Access app for ${host}: update its policy`,
        run: async () => {
          await cf.call('PUT', `/accounts/${a}/access/apps/${app.id}/policies/${ours.id}`, {
            name: POLICY,
            decision: 'allow',
            include,
            exclude: [],
            require: [],
          });
          log(`policy after: ${JSON.stringify(sortedRules((await policiesOf(app.id))[0]?.include ?? []))}`);
        },
      });
    }
  } else if (apps.some((x) => x.domain === host)) {
    refusals.push(`an Access app for ${host} exists but is not recorded in hub.json; it is not adopted`);
  } else {
    log(`policy wanted: ${JSON.stringify(include)}`);
    steps.push({
      say: `Access app for ${host}: create`,
      run: async () => {
        const app = await cf.call<{ id: string; aud: string }>('POST', `/accounts/${a}/access/apps`, {
          name: `specreview ${host}`,
          type: 'self_hosted',
          domain: host,
          session_duration: '24h',
          allowed_idps: otp ? [otp] : undefined,
          auto_redirect_to_identity: false,
          policies: [{ name: POLICY, decision: 'allow', include }],
        });
        access.appId = app.id;
        access.aud = app.aud;
        saveHub(org);
      },
    });
  }

  // The publish path is authenticated by GitHub's token in the hub, so Access
  // lets it through, and only it.
  if (access.publishAppId) {
    const app = apps.find((x) => x.id === access.publishAppId);
    const policies = app ? await policiesOf(app.id) : [];
    const p = policies[0];
    const bypassAll =
      policies.length === 1 &&
      p.decision === 'bypass' &&
      sameRules(p.include, [{ everyone: {} }]) &&
      empty(p.require) &&
      empty(p.exclude);
    if (!app) refusals.push(`Access app ${access.publishAppId} recorded in hub.json is not in the account`);
    else if (app.domain !== publishDomain)
      refusals.push(`Access app ${app.id} is for ${app.domain}, not ${publishDomain}; it was changed by hand`);
    else if (!bypassAll)
      refusals.push(
        `Access app ${app.id} for ${publishDomain} is not a single bypass-everyone policy; setup will not change it`,
      );
    else log(`Access bypass for ${publishDomain}: exists`);
  } else if (apps.some((x) => x.domain === publishDomain)) {
    refusals.push(`an Access app for ${publishDomain} exists but is not recorded in hub.json; it is not adopted`);
  } else {
    steps.push({
      say: `Access bypass for ${publishDomain}: create`,
      run: async () => {
        const app = await cf.call<{ id: string }>('POST', `/accounts/${a}/access/apps`, {
          name: `specreview ${host} publish`,
          type: 'self_hosted',
          domain: publishDomain,
          policies: [{ name: PUBLISH_POLICY, decision: 'bypass', include: [{ everyone: {} }] }],
        });
        access.publishAppId = app.id;
        saveHub(org);
      },
    });
  }

  if (refusals.length > 0) throw new DeployError(`setup stopped before changing anything:\n  ${refusals.join('\n  ')}`);

  if (access.teamDomain !== orgAccess.auth_domain) {
    steps.push({
      say: `Access team domain: record ${orgAccess.auth_domain}`,
      run: async () => {
        access.teamDomain = orgAccess.auth_domain;
        saveHub(org);
      },
    });
  }

  if (steps.length === 0) {
    log('nothing to do');
    return;
  }
  for (const step of steps) {
    if (!opts.apply) {
      log(`plan: ${step.say}`);
      continue;
    }
    await step.run?.();
    log(`done: ${step.say}`);
  }
  if (!opts.apply) log('plan only; rerun with --apply to make these changes');
  else log('hub.json updated; commit it');
};
