// Deploy the hub for one organisation, and set its GitHub tokens, through the
// wrangler in this checkout's lockfile. The Cloudflare token reaches wrangler
// only as CLOUDFLARE_API_TOKEN in its environment; it is never an argument,
// never in the generated config, and never printed.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Cloudflare } from './cloudflare';
import { readToken } from './cloudflare';
import { authoritativeAddresses, probeAddress, type Dns, type Probe, systemDns } from './direct-dns';
import { type Logo, logoOf } from './brand';
import { DeployError, deployable, type Org, saveHub } from './org';
import { HUB_DIR, wranglerConfig } from './wrangler-config';

export type Run = (args: string[], opts: { env: NodeJS.ProcessEnv; input?: string }) => Promise<number>;

// Runs this checkout's wrangler with output passed through.
export const runWrangler =
  (hubDir = HUB_DIR): Run =>
  (args, { env, input }) =>
    new Promise((resolve, reject) => {
      const child = spawn(path.join(hubDir, 'node_modules', '.bin', 'wrangler'), args, {
        cwd: hubDir,
        env,
        stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'],
      });
      child.on('error', reject);
      child.on('exit', (code) => resolve(code ?? 1));
      if (input !== undefined) child.stdin?.end(input);
    });

type Common = { org: Org; tokenFile: string; run: Run; log: (line: string) => void; hubDir?: string };

const withConfig = async <T>(
  org: Org,
  hubDir: string | undefined,
  fn: (configPath: string, dir: string) => Promise<T>,
  logo?: Logo | null,
) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'specreview-deploy-'));
  try {
    const configPath = path.join(dir, 'wrangler.json');
    writeFileSync(configPath, JSON.stringify(wranglerConfig(org, hubDir, logo), null, 2));
    return await fn(configPath, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

// wrangler asks before applying migrations in a terminal; CI=true answers it.
const envFor = (org: Org, tokenFile: string): NodeJS.ProcessEnv => ({
  ...process.env,
  CI: 'true',
  CLOUDFLARE_API_TOKEN: readToken(tokenFile),
  CLOUDFLARE_ACCOUNT_ID: org.hub.accountId,
});

const step = async (run: Run, args: string[], env: NodeJS.ProcessEnv, what: string, input?: string) => {
  const code = await run(args, { env, input });
  if (code !== 0) throw new DeployError(`${what} failed (wrangler exit ${code}); nothing after it ran`);
};

// The hostname is ready once it redirects to the Access login, since nobody
// is signed in. Cloudflare's own error pages (522, 530) while DNS and the
// certificate provision are not ready.
const accessLogin = (location: string | null, teamDomain: string) => {
  const host = (() => {
    try {
      return location ? new URL(location).hostname : '';
    } catch {
      return '';
    }
  })();
  return host === teamDomain;
};
const redirectsToAccess = (status: number, location: string | null, teamDomain: string) =>
  status >= 300 && status < 400 && accessLogin(location, teamDomain);

// The same check through the hostname's own nameservers, every address in
// turn, for when the machine's resolver holds a stale "no such name" (#27).
// Any failure here only means not ready yet.
export const viaNameservers = async (
  hostname: string,
  teamDomain: string,
  { dns = systemDns, probe = probeAddress() }: { dns?: Dns; probe?: Probe } = {},
) => {
  const addresses = await authoritativeAddresses(hostname, dns).catch(() => []);
  for (const address of addresses) {
    const answer = await probe(hostname, address);
    if (answer && redirectsToAccess(answer.status, answer.location, teamDomain)) return true;
  }
  return false;
};

// How to see past a stale answer on this machine. `dig +trace` asks from the
// root down, so no cache on the way is involved.
export const flushAdvice = (hostname: string) =>
  `If \`dig +trace ${hostname}\` ends in an address but this machine cannot resolve the name, its resolver holds a stale answer: ` +
  `on macOS run \`sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder\`, on Linux \`resolvectl flush-caches\`.`;

// Resolves to null when the budget runs out first.
const within = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms).unref())]);

// Each try asks the machine's resolver first, as any client would, so VPN and
// split-horizon DNS keep working; only if that fails, the nameservers, within
// a budget so a network that drops DNS to them does not stretch the wait.
// Says which path answered.
export const waitForHost = async (
  hostname: string,
  teamDomain: string,
  {
    fetchImpl = fetch,
    direct = viaNameservers,
    directBudgetMs = 10_000,
    tries = 30,
    delayMs = 10_000,
  }: {
    fetchImpl?: typeof fetch;
    direct?: (hostname: string, teamDomain: string) => Promise<boolean>;
    directBudgetMs?: number;
    tries?: number;
    delayMs?: number;
  } = {},
): Promise<'resolver' | 'nameservers'> => {
  const started = Date.now();
  for (let i = 0; i < tries; i++) {
    const answered = await fetchImpl(`https://${hostname}/`, { redirect: 'manual' }).then(
      (r) => redirectsToAccess(r.status, r.headers.get('location'), teamDomain),
      () => false,
    );
    if (answered) return 'resolver';
    if (await within(direct(hostname, teamDomain), directBudgetMs)) return 'nameservers';
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new DeployError(
    `deployed, but https://${hostname}/ did not answer within ${Math.round((Date.now() - started) / 1000)} s; DNS or the certificate may still be provisioning. ` +
      `The Worker is deployed. ${flushAdvice(hostname)}`,
  );
};

export const deploy = async ({
  org,
  tokenFile,
  run,
  log,
  hubDir,
  dryRun,
  wait = waitForHost,
  cf,
}: Common & { dryRun: boolean; wait?: typeof waitForHost; cf?: Cloudflare }) => {
  deployable(org.hub);
  // Read once: the file is not looked at again while deploy runs.
  const logo = logoOf(org);
  await withConfig(
    org,
    hubDir,
    async (configPath, dir) => {
      if (dryRun) {
        // No token needed and none passed: a dry run builds, it does not call out.
        await step(
          run,
          ['deploy', '--dry-run', '--config', configPath, '--outdir', path.join(dir, 'out')],
          { ...process.env, CLOUDFLARE_API_TOKEN: '' },
          'wrangler deploy --dry-run',
        );
        log('dry run passed: the hub builds with this configuration');
        return;
      }
      const env = envFor(org, tokenFile);
      // The logo goes up first, under a key of its own, so the Worker deployed
      // next never names a file that is not there yet; the key is recorded as
      // soon as it is stored, so a later failure cannot lose track of it.
      if (logo) {
        // The checked bytes, not whatever is on disk by now.
        const logoFile = path.join(dir, `logo.${logo.key.split('.').pop()}`);
        writeFileSync(logoFile, logo.bytes);
        await step(
          run,
          [
            'r2',
            'object',
            'put',
            `${org.hub.bucket.name}/${logo.key}`,
            '--file',
            logoFile,
            '--content-type',
            logo.type,
            '--remote',
          ],
          env,
          'uploading the logo',
        );
        recordBrand(org, { keys: [logo.key] });
      }
      await step(
        run,
        ['d1', 'migrations', 'apply', 'DB', '--remote', '--config', configPath],
        env,
        'applying D1 migrations',
      );
      await step(run, ['deploy', '--config', configPath], env, 'wrangler deploy');
      // The new Worker is live from here, whatever the wait says next.
      recordBrand(org, { logoKey: logo?.key ?? null });
      if (!cf) throw new DeployError('deploy needs the Cloudflare API to check the hub key');
      await setHubKey(org, cf, run, configPath, env, log);
    },
    logo,
  );
  if (dryRun) return;
  // Each hostname on its own: the docs hostname can answer while the admin
  // hostname's record or certificate is still being made (#75).
  // The prototype hostname too (#116).
  for (const host of [
    org.hub.hostname,
    ...(org.hub.adminHostname ? [org.hub.adminHostname] : []),
    ...(org.hub.protoHostname ? [org.hub.protoHostname] : []),
  ]) {
    log(`waiting for https://${host}/ to answer`);
    const answeredBy = await wait(host, deployable(org.hub).access.teamDomain);
    log(`deployed: https://${host}/`);
    if (answeredBy === 'nameservers') {
      log(
        `this machine's resolver did not find ${host}; the hub answered through its own nameservers. ${flushAdvice(host)}`,
      );
    }
  }
  await retireLogos(org, logo, run, envFor(org, tokenFile), log);
};

// The hub key seals what the hub keeps in D1 (#56): a new key could not open
// what the old one sealed, so it is set only when the Worker has none, asked
// of Cloudflare each time rather than remembered (a put that failed after
// setting it, or a hub.json never pushed, must not lead to a second key). Set
// after the Worker exists (secret put would create one), on stdin.
const setHubKey = async (
  org: Org,
  cf: Cloudflare,
  run: Run,
  configPath: string,
  env: NodeJS.ProcessEnv,
  log: (l: string) => void,
) => {
  const secrets = await cf.call<{ name: string }[]>(
    'GET',
    `/accounts/${org.hub.accountId}/workers/scripts/${org.hub.worker}/secrets`,
  );
  if (secrets.some((s) => s.name === 'SPECREVIEW_KEY')) return;
  await step(
    run,
    ['secret', 'put', 'SPECREVIEW_KEY', '--config', configPath],
    env,
    'setting the hub key',
    randomBytes(32).toString('base64'),
  );
  log('hub key set');
};

// hub.json's record of stored logos: `keys` gains what is given, `logoKey`
// is replaced when given (null: no logo). Written at once, as setup does.
const recordBrand = (org: Org, change: { keys?: string[]; logoKey?: string | null }) => {
  const before = org.hub.brand ?? {};
  // A replaced live key joins the list to delete, including one recorded
  // before hub.json kept a list.
  const replaced = change.logoKey !== undefined && before.logoKey ? [before.logoKey] : [];
  const keys = [...new Set([...(before.keys ?? []), ...replaced, ...(change.keys ?? [])])];
  const logoKey = change.logoKey === undefined ? before.logoKey : (change.logoKey ?? undefined);
  writeBrand(org, logoKey, keys);
};

const writeBrand = (org: Org, logoKey: string | undefined, keys: string[]) => {
  const { brand: _old, ...rest } = org.hub;
  const brand = { ...(logoKey ? { logoKey } : {}), ...(keys.length > 0 ? { keys } : {}) };
  org.hub = Object.keys(brand).length > 0 ? { ...rest, brand } : rest;
  saveHub(org);
};

// Only after the new Worker has answered: delete every stored logo except
// the one it uses. A failed delete stays recorded and is retried next time.
const retireLogos = async (
  org: Org,
  logo: Logo | null,
  run: Run,
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
) => {
  const stale = (org.hub.brand?.keys ?? []).filter((k) => k !== logo?.key);
  const kept: string[] = [];
  for (const key of stale) {
    const code = await run(['r2', 'object', 'delete', `${org.hub.bucket.name}/${key}`, '--remote'], { env });
    if (code === 0) continue;
    kept.push(key);
    log(`warning: the old logo ${key} could not be deleted (wrangler exit ${code}); the next deploy tries again`);
  }
  writeBrand(org, logo?.key, kept);
};

export const SECRET_NAMES = [
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_READ_TOKEN',
  'GITHUB_WRITE_TOKEN',
] as const;

export const secret = async ({
  org,
  tokenFile,
  run,
  log,
  hubDir,
  cf,
  name,
  valueFile,
}: Common & { cf: Cloudflare; name: string; valueFile: string }) => {
  if (!(SECRET_NAMES as readonly string[]).includes(name))
    throw new DeployError(`--name must be one of ${SECRET_NAMES.join(', ')}`);
  const raw = (() => {
    try {
      return readFileSync(valueFile, 'utf8');
    } catch {
      throw new DeployError('--value-file must name a readable file');
    }
  })();
  // A file written by echo or an editor ends in a newline the token does not have.
  const value = raw.replace(/\r?\n$/, '');
  if (!value.trim()) throw new DeployError('--value-file is empty');
  // wrangler secret put would create a Worker that does not exist yet.
  const there = await cf.exists(`/accounts/${org.hub.accountId}/workers/scripts/${org.hub.worker}/settings`);
  if (!there) throw new DeployError(`Worker ${org.hub.worker} does not exist yet; deploy first, then set its secrets`);
  await withConfig(org, hubDir, async (configPath) => {
    const code = await run(['secret', 'put', name, '--config', configPath], {
      env: envFor(org, tokenFile),
      input: value,
    });
    if (code !== 0) throw new DeployError(`wrangler secret put ${name} failed (exit ${code})`);
  });
  log(`${name} set on ${org.hub.worker}`);
};
