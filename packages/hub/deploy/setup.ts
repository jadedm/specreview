// One organisation's Cloudflare resources: a D1 database, an R2 bucket, the
// one-time PIN login, an Access application for the hostname with its allow
// policy, and an Access application bypassing /_publish/* with its bypass
// policy. Policies are reusable Access policies (per-app policies cannot be
// added to new applications) referenced by the applications.
//
// Everything is read first; anything that would have to be refused stops the
// run before a single resource is created. Resources are tracked by the ids
// setup records in hub.json the moment each exists, never adopted by name: a
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
type AppSummary = { id: string; domain?: string };
type App = AppSummary & { type?: string; aud?: string; allowed_idps?: string[]; policies?: { id: string }[] };
type Zone = { id: string; name: string; status: string };

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

const EVERYONE = [{ everyone: {} }];
const sameRules = (a: unknown[] | undefined, b: unknown[]) =>
  JSON.stringify(sortedRules(a ?? [])) === JSON.stringify(sortedRules(b));
const empty = (v: unknown[] | undefined) => v === undefined || v.length === 0;
const onlyEmailRules = (rules: unknown[] | undefined) =>
  (rules ?? []).every(
    (r) => typeof r === 'object' && r !== null && Object.keys(r).every((k) => k === 'email' || k === 'email_domain'),
  );
const sameIds = (a: string[] | undefined, b: string[]) =>
  JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...b].sort());
// The first check that fails names what is wrong; null when none does.
const firstProblem = (checks: [boolean, string][]) => checks.find(([failed]) => failed)?.[1] ?? null;
const notRecorded = (what: string) =>
  `${what} exists but is not recorded in hub.json; it is not adopted. If it is this hub's (a create whose answer was lost), add its id to hub.json and rerun`;

type Step = { say: string; run: () => Promise<void> };

export const setup = async (org: Org, cf: Cloudflare, opts: { apply: boolean; log: (line: string) => void }) => {
  const { hub } = org;
  const a = hub.accountId;
  const host = hub.hostname;
  const publishDomain = `${host}/_publish/*`;
  const log = opts.log;
  const mainPolicyName = `specreview ${host}`;
  const publishPolicyName = `specreview ${host} publish`;

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
  const dbPath = `/accounts/${a}/d1/database/${hub.database.id}`;
  const dbThere = hub.database.id ? await cf.exists(dbPath) : false;
  const db = dbThere ? await cf.call<{ name: string }>('GET', dbPath) : null;
  if (hub.database.id && !db)
    refusals.push(`D1 database ${hub.database.id} recorded in hub.json is not in the account`);
  if (db && db.name !== hub.database.name) {
    refusals.push(`D1 database ${hub.database.id} is named ${db.name}, not ${hub.database.name}`);
  }
  if (db && db.name === hub.database.name) log(`D1 ${hub.database.name}: exists`);
  const dbNamed = hub.database.id
    ? false
    : (await cf.list<{ name: string }>(`/accounts/${a}/d1/database?name=${hub.database.name}`)).some(
        (d) => d.name === hub.database.name,
      );
  if (dbNamed) refusals.push(notRecorded(`a D1 database named ${hub.database.name}`));
  if (!hub.database.id && !dbNamed)
    steps.push({
      say: `D1 ${hub.database.name}: create`,
      run: async () => {
        hub.database.id = (
          await cf.call<{ uuid: string }>('POST', `/accounts/${a}/d1/database`, { name: hub.database.name })
        ).uuid;
        saveHub(org);
      },
    });

  // R2: listed by cursor, filtered to names containing ours.
  const bucketNames: string[] = [];
  for (let cursor: string | undefined, first = true; first || cursor; first = false) {
    const page = await cf.page<{ buckets: { name: string }[] }>(
      'GET',
      `/accounts/${a}/r2/buckets?name_contains=${hub.bucket.name}&per_page=1000${cursor ? `&cursor=${cursor}` : ''}`,
    );
    bucketNames.push(...page.result.buckets.map((b) => b.name));
    cursor = page.cursor;
  }
  const bucketThere = bucketNames.includes(hub.bucket.name);
  if (hub.bucket.created && !bucketThere)
    refusals.push(`R2 bucket ${hub.bucket.name} recorded in hub.json is not in the account`);
  if (hub.bucket.created && bucketThere) log(`R2 ${hub.bucket.name}: exists`);
  if (!hub.bucket.created && bucketThere) refusals.push(notRecorded(`an R2 bucket named ${hub.bucket.name}`));
  if (!hub.bucket.created && !bucketThere)
    steps.push({
      say: `R2 ${hub.bucket.name}: create`,
      run: async () => {
        await cf.call('POST', `/accounts/${a}/r2/buckets`, { name: hub.bucket.name });
        hub.bucket.created = true;
        saveHub(org);
      },
    });

  // Access: two reusable policies and the two applications that use them.
  const access = (hub.access ??= {});
  const policies = await cf.list<Policy>(`/accounts/${a}/access/policies`);
  const apps = await cf.list<AppSummary>(`/accounts/${a}/access/apps`);
  const appOf = async (id: string) =>
    apps.some((x) => x.id === id) ? cf.call<App>('GET', `/accounts/${a}/access/apps/${id}`) : null;

  // The allow policy: kept equal to the config, removals included.
  const mainPolicy = access.policyId ? policies.find((p) => p.id === access.policyId) : undefined;
  if (access.policyId && !mainPolicy)
    refusals.push(`Access policy ${access.policyId} recorded in hub.json is not in the account`);
  const mainPolicyHandEdited =
    mainPolicy &&
    (mainPolicy.decision !== 'allow' ||
      !empty(mainPolicy.require) ||
      !empty(mainPolicy.exclude) ||
      !onlyEmailRules(mainPolicy.include));
  if (mainPolicyHandEdited) {
    refusals.push(
      `Access policy ${mainPolicy.id} is not a plain allow policy of email rules; setup will not change it`,
    );
  }
  if (mainPolicy && !mainPolicyHandEdited && sameRules(mainPolicy.include, include))
    log(`Access policy ${mainPolicyName}: up to date`);
  if (mainPolicy && !mainPolicyHandEdited && !sameRules(mainPolicy.include, include)) {
    log(`policy before: ${JSON.stringify(sortedRules(mainPolicy.include ?? []))}`);
    log(`policy wanted: ${JSON.stringify(include)}`);
    steps.push({
      say: `Access policy ${mainPolicyName}: update`,
      run: async () => {
        await cf.call('PUT', `/accounts/${a}/access/policies/${mainPolicy.id}`, {
          name: mainPolicyName,
          decision: 'allow',
          include,
          exclude: [],
          require: [],
        });
        const after = await cf.call<Policy>('GET', `/accounts/${a}/access/policies/${mainPolicy.id}`);
        log(`policy after: ${JSON.stringify(sortedRules(after.include ?? []))}`);
      },
    });
  }
  const mainPolicyNamed = !access.policyId && policies.some((p) => p.name === mainPolicyName);
  if (mainPolicyNamed) refusals.push(notRecorded(`an Access policy named "${mainPolicyName}"`));
  if (!access.policyId && !mainPolicyNamed) {
    log(`policy wanted: ${JSON.stringify(include)}`);
    steps.push({
      say: `Access policy ${mainPolicyName}: create`,
      run: async () => {
        access.policyId = (
          await cf.call<{ id: string }>('POST', `/accounts/${a}/access/policies`, {
            name: mainPolicyName,
            decision: 'allow',
            include,
          })
        ).id;
        saveHub(org);
      },
    });
  }

  // The bypass policy: everyone, for the publish path only.
  const publishPolicy = access.publishPolicyId ? policies.find((p) => p.id === access.publishPolicyId) : undefined;
  if (access.publishPolicyId && !publishPolicy) {
    refusals.push(`Access policy ${access.publishPolicyId} recorded in hub.json is not in the account`);
  }
  const bypassAll =
    publishPolicy?.decision === 'bypass' &&
    sameRules(publishPolicy.include, EVERYONE) &&
    empty(publishPolicy.require) &&
    empty(publishPolicy.exclude);
  if (publishPolicy && !bypassAll)
    refusals.push(`Access policy ${publishPolicy.id} is not a single bypass-everyone rule; setup will not change it`);
  if (publishPolicy && bypassAll) log(`Access policy ${publishPolicyName}: exists`);
  const publishPolicyNamed = !access.publishPolicyId && policies.some((p) => p.name === publishPolicyName);
  if (publishPolicyNamed) refusals.push(notRecorded(`an Access policy named "${publishPolicyName}"`));
  if (!access.publishPolicyId && !publishPolicyNamed)
    steps.push({
      say: `Access policy ${publishPolicyName}: create`,
      run: async () => {
        access.publishPolicyId = (
          await cf.call<{ id: string }>('POST', `/accounts/${a}/access/policies`, {
            name: publishPolicyName,
            decision: 'bypass',
            include: EVERYONE,
          })
        ).id;
        saveHub(org);
      },
    });

  // The hostname's application: only the one-time PIN login, only our policy.
  const mainApp = access.appId ? await appOf(access.appId) : null;
  if (access.appId && !mainApp) refusals.push(`Access app ${access.appId} recorded in hub.json is not in the account`);
  const mainAppProblem =
    mainApp &&
    firstProblem([
      [
        mainApp.domain !== host || mainApp.type !== 'self_hosted',
        `is for ${mainApp.domain} (${mainApp.type}), not ${host}`,
      ],
      [
        Boolean(access.aud) && mainApp.aud !== access.aud,
        "has a different audience from hub.json's; it was recreated or edited",
      ],
      [
        !sameIds(
          mainApp.policies?.map((p) => p.id),
          access.policyId ? [access.policyId] : [],
        ),
        'has policies other than the one setup recorded',
      ],
      [
        Boolean(otp) && !sameIds(mainApp.allowed_idps, otp ? [otp] : []),
        'allows login methods other than the one-time PIN',
      ],
    ]);
  if (mainApp && mainAppProblem) refusals.push(`Access app ${mainApp.id} ${mainAppProblem}; setup will not change it`);
  if (mainApp && !mainAppProblem) log(`Access app for ${host}: exists`);
  const mainAppNamed = !access.appId && apps.some((x) => x.domain === host);
  if (mainAppNamed) refusals.push(notRecorded(`an Access app for ${host}`));
  if (!access.appId && !mainAppNamed)
    steps.push({
      say: `Access app for ${host}: create`,
      run: async () => {
        const app = await cf.call<{ id: string; aud: string }>('POST', `/accounts/${a}/access/apps`, {
          name: `specreview ${host}`,
          type: 'self_hosted',
          domain: host,
          session_duration: '24h',
          allowed_idps: [otp],
          auto_redirect_to_identity: true,
          policies: [{ id: access.policyId, precedence: 1 }],
        });
        access.appId = app.id;
        access.aud = app.aud;
        saveHub(org);
      },
    });

  // The publish path is authenticated by GitHub's token in the hub, so Access
  // lets it through, and only it.
  const publishApp = access.publishAppId ? await appOf(access.publishAppId) : null;
  if (access.publishAppId && !publishApp) {
    refusals.push(`Access app ${access.publishAppId} recorded in hub.json is not in the account`);
  }
  const publishAppProblem =
    publishApp &&
    firstProblem([
      [publishApp.domain !== publishDomain, `is for ${publishApp.domain}, not ${publishDomain}`],
      [
        !sameIds(
          publishApp.policies?.map((p) => p.id),
          access.publishPolicyId ? [access.publishPolicyId] : [],
        ),
        'has policies other than the one setup recorded',
      ],
    ]);
  if (publishApp && publishAppProblem)
    refusals.push(`Access app ${publishApp.id} ${publishAppProblem}; setup will not change it`);
  if (publishApp && !publishAppProblem) log(`Access bypass for ${publishDomain}: exists`);
  const publishAppNamed = !access.publishAppId && apps.some((x) => x.domain === publishDomain);
  if (publishAppNamed) refusals.push(notRecorded(`an Access app for ${publishDomain}`));
  if (!access.publishAppId && !publishAppNamed)
    steps.push({
      say: `Access bypass for ${publishDomain}: create`,
      run: async () => {
        const app = await cf.call<{ id: string }>('POST', `/accounts/${a}/access/apps`, {
          name: `specreview ${host} publish`,
          type: 'self_hosted',
          domain: publishDomain,
          policies: [{ id: access.publishPolicyId, precedence: 1 }],
        });
        access.publishAppId = app.id;
        saveHub(org);
      },
    });

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
    await step.run();
    log(`done: ${step.say}`);
  }
  if (!opts.apply) log('plan only; rerun with --apply to make these changes');
  else log('hub.json updated; commit it');
};
