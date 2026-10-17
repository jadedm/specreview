// One organisation's Cloudflare resources: a D1 database, an R2 bucket, the
// one-time PIN login, an Access application for the hostname with its allow
// policy, an Access application bypassing /_publish/* with its bypass policy,
// and, while any site is public (#20), an application bypassing those sites'
// pages with its own bypass policy, their API, history and sign-in paths
// staying on the hostname's application. Policies are reusable Access policies (per-app policies cannot be
// added to new applications) referenced by the applications.
//
// Everything is read first; anything that would have to be refused stops the
// run before a single resource is created. Resources are tracked by the ids
// setup records in hub.json the moment each exists, never adopted by name: a
// database or app with the right name but no recorded id may belong to
// someone else.
import { CloudflareError, type Cloudflare } from './cloudflare';
import { DeployError, saveHub, type Org, workerConfigOf } from './org';

type Rule = { email?: { email: string }; email_domain?: { domain: string }; everyone?: Record<string, never> };
type Policy = {
  id: string;
  app_count?: number;
  name?: string;
  decision?: string;
  include?: unknown[];
  exclude?: unknown[];
  require?: unknown[];
};
type AppSummary = { id: string; domain?: string; name?: string };
type App = AppSummary & {
  type?: string;
  aud?: string;
  allowed_idps?: string[];
  policies?: { id: string }[];
  destinations?: { type?: string; uri?: string }[];
  self_hosted_domains?: string[];
  cors_headers?: { allow_all_origins?: boolean; allowed_origins?: string[] };
  options_preflight_bypass?: boolean;
  allow_authenticate_via_warp?: boolean;
  allow_iframe?: boolean;
};

// Every hostname or path an app covers: since destinations, an app protects
// (or, for a bypass, opens) each of them, not only its domain. Cloudflare
// ignores self_hosted_domains on an app that has destinations.
const coveredBy = (app: App) =>
  [
    ...new Set([
      app.domain,
      ...(app.destinations?.length ? app.destinations.map((d) => d.uri) : (app.self_hosted_domains ?? [])),
    ]),
  ].filter((d): d is string => typeof d === 'string');
// Settings that let more in or let other sites read, which setup keeps on
// the hostname's app without checking.
const widenedBy = (app: App) =>
  [
    [
      Boolean(app.cors_headers?.allow_all_origins || app.cors_headers?.allowed_origins?.length),
      'CORS allowing other origins',
    ],
    [app.options_preflight_bypass === true, 'preflight bypass'],
    [app.allow_iframe === true, 'framing allowed'],
  ]
    .filter(([on]) => on)
    .map(([, what]) => what as string);
const coversOnly = (app: App, domain: string) => coveredBy(app).length === 1 && coveredBy(app)[0] === domain;
export type Zone = { id: string; name: string; status: string };

// The zone a hostname lives in: the longest zone name covering it.
export const zoneCovering = (zones: Zone[], host: string) =>
  zones.filter((z) => host === z.name || host.endsWith(`.${z.name}`)).sort((x, y) => y.name.length - x.name.length)[0];

const ruleKey = (r: unknown) => JSON.stringify(r);
// Code-point order, so the result is the same on every machine and locale.
const byKey = (a: unknown, b: unknown) => (ruleKey(a) < ruleKey(b) ? -1 : ruleKey(a) > ruleKey(b) ? 1 : 0);
const sortedRules = (rules: unknown[]) => [...new Map(rules.map((r) => [ruleKey(r), r])).values()].sort(byKey);

// Who may pass Access: everyone at a team domain, each person named in team,
// each approver and reader (an email or a whole @domain), and each admin. Only email and email-domain rules: a
// login-method rule would admit anyone who can receive a code.
export const wantedInclude = (config: Record<string, unknown>): Rule[] => {
  const sites =
    (config.sites as { teamDomains: string[]; team?: string[]; approvers?: string[]; readers: string[] }[]) ?? [];
  const rules: Rule[] = [];
  const asRule = (entry: string): Rule =>
    entry.startsWith('@') ? { email_domain: { domain: entry.slice(1) } } : { email: { email: entry } };
  for (const domain of sites.flatMap((s) => s.teamDomains)) rules.push({ email_domain: { domain } });
  for (const entry of sites.flatMap((s) => s.readers)) rules.push(asRule(entry));
  for (const email of (config.admins as string[]) ?? []) rules.push({ email: { email } });
  // Team by email and approvers anywhere (#91) sign in too; an email a domain
  // rule already covers is left out, so existing hubs' policies are unchanged.
  const extra = sites.flatMap((s) => [...(s.team ?? []), ...(s.approvers ?? [])]);
  for (const entry of extra.filter((e) => e.startsWith('@'))) rules.push(asRule(entry));
  const domains = new Set(rules.flatMap((r) => (r.email_domain ? [r.email_domain.domain] : [])));
  for (const entry of extra.filter((e) => !e.startsWith('@')))
    if (!domains.has(entry.split('@')[1])) rules.push(asRule(entry));
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
const notRecorded = (what: string, adopt = 'add its id to hub.json') =>
  `${what} exists but is not recorded in hub.json; it is not adopted. If it is this hub's (a create whose answer was lost), ${adopt} and rerun`;

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
  // The admin app does not exist yet on a first run: a placeholder audience
  // checks the rest (#75).
  workerConfigOf(org, {
    teamDomain: 'check.cloudflareaccess.com',
    aud: 'check',
    adminAud: 'check-admin',
    protoAud: 'check-proto',
  });
  const include = wantedInclude(org.config);
  // Public sites (#20): their pages bypass Access; their API, history and
  // sign-in path stay on the hostname's app, which keeps its audience.
  const sites = (org.config.sites as { repo: string; visibility?: string }[]) ?? [];
  const publicRepos = sites.filter((s) => s.visibility === 'public').map((s) => s.repo);
  const protectedPaths = (repos: string[]) =>
    repos.flatMap((r) => [`${host}/${r}/_api/*`, `${host}/${r}/_history/*`, `${host}/${r}/_signin`]);
  const pagePaths = (repos: string[]) => repos.map((r) => `${host}/${r}/*`);
  const wantedMain = [host, ...protectedPaths(publicRepos)];
  // What setup itself may have written, for any repo name (a site removed
  // from the config still has its paths on the apps until this run):
  // the hostname, <host>/<repo>/_api/*, /_history/* and /_signin on the main
  // app, <host>/<repo>/* on the bypass.
  const hostRe = host.replace(/[.]/g, '\\.');
  // Repo names as the config allows them: no leading underscore, never . or ..
  const repoRe = '(?!\\.{1,2}/)[a-z0-9.][a-z0-9._-]{0,99}';
  const ownMainPath = new RegExp(`^${hostRe}(/${repoRe}/(_api/\\*|_history/\\*|_signin))?$`);
  const ownPagePath = new RegExp(`^${hostRe}/${repoRe}/\\*$`);
  const publicPolicyName = `specreview ${host} public`;
  const publicAppName = `specreview ${host} public`;
  const wantPublic = publicRepos.length > 0;
  const sameSet = (x: string[], y: string[]) => x.length === y.length && x.every((d) => y.includes(d));

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

  // Each hostname (the docs sites', and the admin page's when set, #75): its
  // zone is in this account and active, and nothing else serves it. A custom
  // domain already on this Worker is a previous deploy.
  const zones = await cf.list<Zone>(`/zones?account.id=${a}`);
  const checkHostname = async (name: string) => {
    const zone = zoneCovering(zones, name);
    if (!zone) refusals.push(`no zone in account ${a} covers ${name}`);
    if (zone && zone.status !== 'active') refusals.push(`zone ${zone.name} is ${zone.status}, not active`);
    if (!zone) return;
    const domains = await cf.call<{ hostname: string; service: string }[]>(
      'GET',
      `/accounts/${a}/workers/domains?hostname=${name}`,
    );
    const mine = domains.some((d) => d.hostname === name && d.service === hub.worker);
    const other = domains.find((d) => d.hostname === name && d.service !== hub.worker);
    if (other) refusals.push(`${name} is already the custom domain of Worker ${other.service}`);
    const records = await cf.call<unknown[]>('GET', `/zones/${zone.id}/dns_records?name=${name}`);
    if (records.length > 0 && !mine)
      refusals.push(`${name} already has a DNS record; remove it or pick another hostname`);
    log(`hostname ${name}: zone ${zone.name} ${mine ? '(already served by this Worker)' : 'is free'}`);
  };
  await checkHostname(host);
  if (hub.adminHostname) await checkHostname(hub.adminHostname);
  if (hub.protoHostname) await checkHostname(hub.protoHostname);

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
  if (!hub.bucket.created && bucketThere) {
    refusals.push(notRecorded(`an R2 bucket named ${hub.bucket.name}`, 'set bucket.created to true in hub.json'));
  }
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
  const apps = await cf.list<App>(`/accounts/${a}/access/apps`);
  const appOf = async (id: string) =>
    apps.some((x) => x.id === id) ? cf.call<App>('GET', `/accounts/${a}/access/apps/${id}`) : null;

  // The allow policy: kept equal to the config, removals included.
  const mainPolicy = access.policyId ? policies.find((p) => p.id === access.policyId) : undefined;
  if (access.policyId && !mainPolicy)
    refusals.push(`Access policy ${access.policyId} recorded in hub.json is not in the account`);
  const mainPolicyHandEdited =
    mainPolicy &&
    ((mainPolicy.app_count ?? 0) > 1 ||
      mainPolicy.decision !== 'allow' ||
      !empty(mainPolicy.require) ||
      !empty(mainPolicy.exclude) ||
      !onlyEmailRules(mainPolicy.include));
  if (mainPolicyHandEdited) {
    refusals.push(
      `Access policy ${mainPolicy.id} is not a plain allow policy of email rules used by one app; setup will not change it`,
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
    (publishPolicy?.app_count ?? 0) <= 1 &&
    publishPolicy?.decision === 'bypass' &&
    sameRules(publishPolicy.include, EVERYONE) &&
    empty(publishPolicy.require) &&
    empty(publishPolicy.exclude);
  if (publishPolicy && !bypassAll)
    refusals.push(
      `Access policy ${publishPolicy.id} is not a single bypass-everyone rule used by one app; setup will not change it`,
    );
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

  // The hostname's application, as setup writes it: the hostname and the
  // public sites' protected paths, only the one-time PIN login, only our policy.
  // An update keeps every setting of the app as it is (session length,
  // cookies, CORS, deny pages) and changes only what it covers.
  const updatedMainApp = (current: App, uris: string[]) => {
    // GET answers with read-only fields, the old domain list and whole policy
    // objects; the update sends links to policies and only destinations.
    const { id: _id, aud: _aud, ...rest } = current as App & Record<string, unknown>;
    for (const key of ['created_at', 'updated_at', 'self_hosted_domains'])
      delete (rest as Record<string, unknown>)[key];
    return {
      ...rest,
      domain: host,
      destinations: uris.map((uri) => ({ type: 'public', uri })),
      policies: (current.policies ?? []).map((p, i) => ({ id: p.id, precedence: i + 1 })),
    };
  };
  const mainAppBody = (uris: string[]) => ({
    name: `specreview ${host}`,
    type: 'self_hosted',
    domain: host,
    destinations: uris.map((uri) => ({ type: 'public', uri })),
    session_duration: '24h',
    allowed_idps: [otp],
    auto_redirect_to_identity: true,
    policies: [{ id: access.policyId, precedence: 1 }],
  });

  // The hostname's application: only the one-time PIN login, only our policy.
  const mainApp = access.appId ? await appOf(access.appId) : null;
  if (access.appId && !mainApp) refusals.push(`Access app ${access.appId} recorded in hub.json is not in the account`);
  const mainAppProblem =
    mainApp &&
    firstProblem([
      [
        !coveredBy(mainApp).includes(host) ||
          coveredBy(mainApp).some((d) => !ownMainPath.test(d)) ||
          (mainApp.destinations ?? []).some((d) => d.type !== undefined && d.type !== 'public') ||
          mainApp.type !== 'self_hosted',
        `covers ${coveredBy(mainApp).join(', ')} (${mainApp.type}), not only ${host} and the public sites' protected paths`,
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
      // Without the PIN login there is nothing to compare against, and an
      // empty list means every login method: refuse rather than guess.
      [!otp || !sameIds(mainApp.allowed_idps, otp ? [otp] : []), 'allows login methods other than the one-time PIN'],
      // A WARP session signs in past the login methods above.
      [mainApp.allow_authenticate_via_warp === true, 'allows sign-in through a WARP session'],
    ]);
  if (mainApp && mainAppProblem) refusals.push(`Access app ${mainApp.id} ${mainAppProblem}; setup will not change it`);
  if (mainApp && !mainAppProblem) log(`Access app for ${host}: exists`);
  // Settings setup keeps on an update and does not check; said, not refused.
  const widened = mainApp && !mainAppProblem ? widenedBy(mainApp) : [];
  if (widened.length > 0)
    log(`Access app for ${host}: note, it has ${widened.join(', ')}; setup keeps these as they are`);
  // An app adopted by its id (after a lost create) has no audience recorded yet.
  if (mainApp && !mainAppProblem && !access.aud)
    steps.push({
      say: `Access app for ${host}: record its audience`,
      run: async () => {
        access.aud = mainApp.aud;
        saveHub(org);
      },
    });
  const mainAppNamed = !access.appId && apps.some((x) => x.domain === host);
  if (mainAppNamed) refusals.push(notRecorded(`an Access app for ${host}`));
  if (!access.appId && !mainAppNamed)
    steps.push({
      say: `Access app for ${host}: create`,
      run: async () => {
        const app = await cf.call<{ id: string; aud: string }>(
          'POST',
          `/accounts/${a}/access/apps`,
          mainAppBody(wantedMain),
        );
        access.appId = app.id;
        access.aud = app.aud;
        saveHub(org);
      },
    });
  // Destinations change in two steps around the public app: first grow to
  // cover both old and new protected paths, then, once the public app no
  // longer opens a site, shrink. A site's API is never left under a bypass.
  const mainNow = mainApp && !mainAppProblem ? coveredBy(mainApp) : null;
  const mainGrown = mainNow ? [...new Set([...mainNow, ...wantedMain])] : null;
  if (mainNow && mainGrown && !sameSet(mainNow, mainGrown))
    steps.push({
      say: `Access app for ${host}: cover ${mainGrown.filter((d) => !mainNow.includes(d)).join(', ')}`,
      run: async () => {
        await cf.call('PUT', `/accounts/${a}/access/apps/${access.appId}`, updatedMainApp(mainApp!, mainGrown));
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
      [
        !coversOnly(publishApp, publishDomain) || publishApp.type !== 'self_hosted',
        `covers ${coveredBy(publishApp).join(', ')} (${publishApp.type}), not only ${publishDomain}`,
      ],
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

  // An extra hostname with its own Access app and policy, kept by setup: the
  // admin page's (#75, admins only) and the prototypes' (#116, the site's
  // readers). Each shares no origin and no sign-in with the docs sites. Its
  // policy is kept equal to what the config implies, like the main one; the
  // app may not let other origins read it (CORS) or skip Access for
  // preflights. Without the hostname, its app and then its policy go, but
  // only while they are still only ours; a record whose resource is already
  // gone is forgotten.
  type OwnIds = {
    policy: 'adminPolicyId' | 'protoPolicyId';
    app: 'adminAppId' | 'protoAppId';
    aud: 'adminAud' | 'protoAud';
  };
  const corsOpen = (app: App) =>
    app.cors_headers?.allow_all_origins === true ||
    (app.cors_headers?.allowed_origins ?? []).length > 0 ||
    app.options_preflight_bypass === true;
  const ownHostname = async (
    own: string | undefined,
    policyName: string,
    ownInclude: unknown[],
    ids: OwnIds,
    label: string,
  ) => {
    const ownPolicy = access[ids.policy] ? policies.find((p) => p.id === access[ids.policy]) : undefined;
    const ownApp = access[ids.app] ? await appOf(access[ids.app] as string) : null;
    if (own) {
      if (access[ids.policy] && !ownPolicy)
        refusals.push(`Access policy ${access[ids.policy]} recorded in hub.json is not in the account`);
      const policyHandEdited =
        ownPolicy &&
        ((ownPolicy.app_count ?? 0) > 1 ||
          ownPolicy.decision !== 'allow' ||
          !empty(ownPolicy.require) ||
          !empty(ownPolicy.exclude) ||
          !onlyEmailRules(ownPolicy.include));
      if (policyHandEdited)
        refusals.push(
          `Access policy ${ownPolicy.id} is not a plain allow policy of email rules used by one app; setup will not change it`,
        );
      if (ownPolicy && !policyHandEdited && sameRules(ownPolicy.include, ownInclude))
        log(`Access policy ${policyName}: up to date`);
      if (ownPolicy && !policyHandEdited && !sameRules(ownPolicy.include, ownInclude))
        steps.push({
          say: `Access policy ${policyName}: update`,
          run: async () => {
            await cf.call('PUT', `/accounts/${a}/access/policies/${ownPolicy.id}`, {
              name: policyName,
              decision: 'allow',
              include: ownInclude,
              exclude: [],
              require: [],
            });
          },
        });
      const policyNamed = !access[ids.policy] && policies.some((p) => p.name === policyName);
      if (policyNamed) refusals.push(notRecorded(`an Access policy named "${policyName}"`));
      if (!access[ids.policy] && !policyNamed)
        steps.push({
          say: `Access policy ${policyName}: create`,
          run: async () => {
            access[ids.policy] = (
              await cf.call<{ id: string }>('POST', `/accounts/${a}/access/policies`, {
                name: policyName,
                decision: 'allow',
                include: ownInclude,
              })
            ).id;
            saveHub(org);
          },
        });

      if (access[ids.app] && !ownApp)
        refusals.push(`Access app ${access[ids.app]} recorded in hub.json is not in the account`);
      const appProblem =
        ownApp &&
        firstProblem([
          [
            !coversOnly(ownApp, own) || ownApp.type !== 'self_hosted',
            `covers ${coveredBy(ownApp).join(', ')} (${ownApp.type}), not only ${own}`,
          ],
          [
            Boolean(access[ids.aud]) && ownApp.aud !== access[ids.aud],
            "has a different audience from hub.json's; it was recreated or edited",
          ],
          [
            !sameIds(
              ownApp.policies?.map((p) => p.id),
              access[ids.policy] ? [access[ids.policy] as string] : [],
            ),
            'has policies other than the one setup recorded',
          ],
          [!otp || !sameIds(ownApp.allowed_idps, otp ? [otp] : []), 'allows login methods other than the one-time PIN'],
          [corsOpen(ownApp), 'lets other origins read it (CORS) or skips Access for preflights'],
          [ownApp.allow_authenticate_via_warp === true, 'allows sign-in through a WARP session'],
        ]);
      if (ownApp && appProblem) refusals.push(`Access app ${ownApp.id} ${appProblem}; setup will not change it`);
      if (ownApp && !appProblem) log(`Access app for ${own}: exists`);
      if (ownApp && !appProblem && !access[ids.aud])
        steps.push({
          say: `Access app for ${own}: record its audience`,
          run: async () => {
            access[ids.aud] = ownApp.aud;
            saveHub(org);
          },
        });
      const appNamed = !access[ids.app] && apps.some((x) => x.domain === own);
      if (appNamed) refusals.push(notRecorded(`an Access app for ${own}`));
      if (!access[ids.app] && !appNamed)
        steps.push({
          say: `Access app for ${own}: create`,
          run: async () => {
            const app = await cf.call<{ id: string; aud: string }>('POST', `/accounts/${a}/access/apps`, {
              name: `specreview ${own}`,
              type: 'self_hosted',
              domain: own,
              session_duration: '24h',
              allowed_idps: [otp],
              auto_redirect_to_identity: true,
              policies: [{ id: access[ids.policy], precedence: 1 }],
            });
            access[ids.app] = app.id;
            access[ids.aud] = app.aud;
            saveHub(org);
          },
        });
      return;
    }
    const appNotOurs =
      ownApp &&
      (coveredBy(ownApp).length !== 1 ||
        ownApp.type !== 'self_hosted' ||
        !sameIds(
          ownApp.policies?.map((p) => p.id),
          access[ids.policy] ? [access[ids.policy] as string] : [],
        ));
    // With our app gone, any app still using the policy is someone else's.
    const policyNotOurs =
      ownPolicy && ((ownPolicy.app_count ?? 0) > (ownApp ? 1 : 0) || ownPolicy.decision !== 'allow');
    if (appNotOurs)
      refusals.push(
        `Access app ${ownApp.id} recorded as the ${label}'s covers ${coveredBy(ownApp).join(', ')} or has other policies; setup will not delete it`,
      );
    if (policyNotOurs)
      refusals.push(
        `Access policy ${ownPolicy.id} recorded as the ${label}'s is used by other apps; setup will not delete it`,
      );
    if (access[ids.app])
      steps.push({
        say: `Access app for the old ${label}: delete`,
        run: async () => {
          if (ownApp) await cf.call('DELETE', `/accounts/${a}/access/apps/${access[ids.app]}`);
          delete access[ids.app];
          delete access[ids.aud];
          saveHub(org);
        },
      });
    if (access[ids.policy])
      steps.push({
        say: `Access policy for the old ${label}: delete`,
        run: async () => {
          if (ownPolicy) await cf.call('DELETE', `/accounts/${a}/access/policies/${access[ids.policy]}`);
          delete access[ids.policy];
          saveHub(org);
        },
      });
  };

  const adminHost = hub.adminHostname;
  await ownHostname(
    adminHost,
    `specreview ${adminHost ?? host} admins`,
    sortedRules(((org.config.admins as string[] | undefined) ?? []).map((email) => ({ email: { email } }))),
    { policy: 'adminPolicyId', app: 'adminAppId', aud: 'adminAud' },
    'admin hostname',
  );
  // The prototypes' hostname (#116): the docs hostname's readers, through a
  // policy of its own kept equal to the main one (the main policy stays on
  // one app). Its ids may not be any other resource's.
  const protoHost = hub.protoHostname;
  // An extra hostname's ids (admin or prototype) may be no other resource's:
  // setup would keep or delete the wrong one.
  const policyKeys = ['policyId', 'publishPolicyId', 'publicPolicyId', 'adminPolicyId', 'protoPolicyId'] as const;
  const appKeys = ['appId', 'publishAppId', 'publicAppId', 'adminAppId', 'protoAppId'] as const;
  for (const [own, keys, kind] of [
    ['adminPolicyId', policyKeys, 'policies'],
    ['protoPolicyId', policyKeys, 'policies'],
    ['adminAppId', appKeys, 'apps'],
    ['protoAppId', appKeys, 'apps'],
  ] as const) {
    const id = access[own];
    if (id && keys.some((k) => k !== own && access[k] === id))
      refusals.push(`hub.json access.${own} ${id} is another of the hub's ${kind}`);
  }
  await ownHostname(
    protoHost,
    `specreview ${protoHost ?? host} readers`,
    include,
    { policy: 'protoPolicyId', app: 'protoAppId', aud: 'protoAud' },
    'prototype hostname',
  );

  // The public sites' bypass policy and app (#20). A record whose resource is
  // gone (a delete whose answer was lost) is forgotten, not refused: both are
  // ours by their recorded id, and recreating them is safe.
  const publicPolicy = access.publicPolicyId ? policies.find((p) => p.id === access.publicPolicyId) : undefined;
  const publicPolicyGone = Boolean(access.publicPolicyId) && !publicPolicy;
  const publicPolicyOk =
    (publicPolicy?.app_count ?? 0) <= 1 &&
    publicPolicy?.decision === 'bypass' &&
    sameRules(publicPolicy.include, EVERYONE) &&
    empty(publicPolicy.require) &&
    empty(publicPolicy.exclude);
  if (publicPolicy && !publicPolicyOk)
    refusals.push(
      `Access policy ${publicPolicy.id} is not a single bypass-everyone rule used by one app; setup will not change it`,
    );
  // Checked when nothing is recorded and when the recorded one is gone: a
  // same-name policy is never ours to adopt or to sit beside.
  const publicPolicyNamed =
    (!access.publicPolicyId || !policies.some((p) => p.id === access.publicPolicyId)) &&
    policies.some((p) => p.name === publicPolicyName && p.id !== access.publicPolicyId);
  if (publicPolicyNamed) refusals.push(notRecorded(`an Access policy named "${publicPolicyName}"`));
  const publicApp = access.publicAppId ? await appOf(access.publicAppId) : null;
  const publicAppGone = Boolean(access.publicAppId) && !publicApp;
  const publicAppProblem =
    publicApp &&
    firstProblem([
      [
        publicApp.type !== 'self_hosted' ||
          coveredBy(publicApp).some((d) => !ownPagePath.test(d)) ||
          (publicApp.destinations ?? []).some((d) => d.type !== undefined && d.type !== 'public'),
        `covers ${coveredBy(publicApp).join(', ')} (${publicApp.type}), not only public sites' pages`,
      ],
      [
        !sameIds(
          publicApp.policies?.map((p) => p.id),
          access.publicPolicyId ? [access.publicPolicyId] : [],
        ),
        'has policies other than the one setup recorded',
      ],
    ]);
  if (publicApp && publicAppProblem)
    refusals.push(`Access app ${publicApp.id} ${publicAppProblem}; setup will not change it`);
  const publicAppNamed =
    (!access.publicAppId || !apps.some((x) => x.id === access.publicAppId)) &&
    apps.some((x) => x.name === publicAppName && x.id !== access.publicAppId);
  if (publicAppNamed) refusals.push(notRecorded(`an Access app named "${publicAppName}"`));
  const forget = (key: 'publicPolicyId' | 'publicAppId', what: string) =>
    steps.unshift({
      say: `${what} recorded in hub.json is gone: forget it`,
      run: async () => {
        delete access[key];
        saveHub(org);
      },
    });
  if (publicAppGone) forget('publicAppId', `Access app ${access.publicAppId}`);
  if (publicPolicyGone) forget('publicPolicyId', `Access policy ${access.publicPolicyId}`);
  const hasPublicPolicy = Boolean(publicPolicy);
  const hasPublicApp = Boolean(publicApp);
  if (wantPublic && !hasPublicPolicy && !publicPolicyNamed)
    steps.push({
      say: `Access policy ${publicPolicyName}: create`,
      run: async () => {
        access.publicPolicyId = (
          await cf.call<{ id: string }>('POST', `/accounts/${a}/access/policies`, {
            name: publicPolicyName,
            decision: 'bypass',
            include: EVERYONE,
          })
        ).id;
        saveHub(org);
      },
    });
  const publicAppBody = () => ({
    name: publicAppName,
    type: 'self_hosted',
    domain: pagePaths(publicRepos)[0],
    destinations: pagePaths(publicRepos).map((uri) => ({ type: 'public', uri })),
    policies: [{ id: access.publicPolicyId, precedence: 1 }],
  });
  if (wantPublic && !hasPublicApp && !publicAppNamed)
    steps.push({
      say: `Access bypass for ${pagePaths(publicRepos).join(', ')}: create`,
      run: async () => {
        access.publicAppId = (await cf.call<{ id: string }>('POST', `/accounts/${a}/access/apps`, publicAppBody())).id;
        saveHub(org);
      },
    });
  if (
    wantPublic &&
    publicApp &&
    !publicAppProblem &&
    (publicPolicyGone || !sameSet(coveredBy(publicApp), pagePaths(publicRepos)))
  )
    steps.push({
      say: `Access bypass: cover exactly ${pagePaths(publicRepos).join(', ')}`,
      run: async () => {
        await cf.call('PUT', `/accounts/${a}/access/apps/${access.publicAppId}`, publicAppBody());
      },
    });
  if (!wantPublic && publicApp && !publicAppProblem)
    steps.push({
      say: `Access bypass for public sites: delete (no site is public)`,
      run: async () => {
        await cf.call('DELETE', `/accounts/${a}/access/apps/${access.publicAppId}`);
        delete access.publicAppId;
        saveHub(org);
      },
    });
  if (mainGrown && !sameSet(mainGrown, wantedMain))
    steps.push({
      say: `Access app for ${host}: stop covering ${mainGrown.filter((d) => !wantedMain.includes(d)).join(', ')}`,
      run: async () => {
        await cf.call('PUT', `/accounts/${a}/access/apps/${access.appId}`, updatedMainApp(mainApp!, wantedMain));
      },
    });
  if (!wantPublic && publicPolicy && publicPolicyOk)
    steps.push({
      say: `Access policy ${publicPolicyName}: delete (no site is public)`,
      run: async () => {
        await cf.call('DELETE', `/accounts/${a}/access/policies/${access.publicPolicyId}`);
        delete access.publicPolicyId;
        saveHub(org);
      },
    });

  // Any other app over the hub's hostnames or a path under them: Access
  // applies the most specific match, so it could open or shadow part of the
  // hub. Apps already refused above as possibly this hub's are not repeated.
  const recorded = new Set([
    access.appId,
    access.publishAppId,
    access.publicAppId,
    access.adminAppId,
    access.protoAppId,
  ]);
  const hubHosts = [host, ...(adminHost ? [adminHost] : []), ...(protoHost ? [protoHost] : [])];
  // An exact host, a path under it, or a wildcard host with a path (more
  // specific than the hub's own app, so it wins); a bare *.example.com app
  // does not take a hostname from an app made for it.
  const overHub = (entry: string) => {
    const d = entry.toLowerCase();
    const [name, ...rest] = d.split('/');
    const wildcard = name.startsWith('*.') && rest.length > 0;
    return hubHosts.some(
      (h) => d === h || d.startsWith(`${h}/`) || d.startsWith(`${h}*`) || (wildcard && h.endsWith(name.slice(1))),
    );
  };
  const reportedAbove = (x: App) =>
    (!access.appId && x.domain === host) ||
    (!access.publishAppId && x.domain === publishDomain) ||
    (Boolean(adminHost) && !access.adminAppId && x.domain === adminHost) ||
    (Boolean(protoHost) && !access.protoAppId && x.domain === protoHost) ||
    (publicAppNamed && x.name === publicAppName);
  // A bookmark only lists a link; it protects and opens nothing.
  for (const x of apps.filter((x) => !recorded.has(x.id) && !reportedAbove(x) && x.type !== 'bookmark')) {
    const over = coveredBy(x).filter(overHub);
    if (over.length > 0)
      refusals.push(
        `Access app ${x.id}${x.name ? ` ("${x.name}")` : ''} covers ${over.join(', ')} and is not recorded in hub.json; it could open or shadow part of the hub, so remove it or take those paths out of it`,
      );
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
  const before = JSON.stringify(org.hub);
  for (const step of steps) {
    if (!opts.apply) {
      log(`plan: ${step.say}`);
      continue;
    }
    await step.run();
    log(`done: ${step.say}`);
  }
  if (!opts.apply) log('plan only; rerun with --apply to make these changes');
  // Only ids and the like are recorded; an update to a policy changes nothing here.
  else log(JSON.stringify(org.hub) === before ? 'done; hub.json unchanged' : 'hub.json updated; commit it');
};
