// Deploy the hub for one organisation, and set its GitHub tokens, through the
// wrangler in this checkout's lockfile. The Cloudflare token reaches wrangler
// only as CLOUDFLARE_API_TOKEN in its environment; it is never an argument,
// never in the generated config, and never printed.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Cloudflare } from './cloudflare';
import { readToken } from './cloudflare';
import { DeployError, deployable, type Org } from './org';
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
) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'specreview-deploy-'));
  try {
    const configPath = path.join(dir, 'wrangler.json');
    writeFileSync(configPath, JSON.stringify(wranglerConfig(org, hubDir), null, 2));
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

const step = async (run: Run, args: string[], env: NodeJS.ProcessEnv, what: string) => {
  const code = await run(args, { env });
  if (code !== 0) throw new DeployError(`${what} failed (wrangler exit ${code}); nothing after it ran`);
};

// The hostname is ready once it redirects to the Access login, since nobody
// is signed in. Cloudflare's own error pages (522, 530) while DNS and the
// certificate provision are not ready.
const accessLogin = (location: string | null) => {
  const host = (() => {
    try {
      return location ? new URL(location).hostname : '';
    } catch {
      return '';
    }
  })();
  return host.endsWith('.cloudflareaccess.com');
};
export const waitForHost = async (
  hostname: string,
  {
    fetchImpl = fetch,
    tries = 30,
    delayMs = 10_000,
  }: { fetchImpl?: typeof fetch; tries?: number; delayMs?: number } = {},
) => {
  for (let i = 0; i < tries; i++) {
    const answered = await fetchImpl(`https://${hostname}/`, { redirect: 'manual' }).then(
      (r) => r.status >= 300 && r.status < 400 && accessLogin(r.headers.get('location')),
      () => false,
    );
    if (answered) return;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new DeployError(
    `deployed, but https://${hostname}/ did not answer within ${Math.round((tries * delayMs) / 1000)} s; DNS or the certificate may still be provisioning`,
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
}: Common & { dryRun: boolean; wait?: typeof waitForHost }) => {
  deployable(org.hub);
  await withConfig(org, hubDir, async (configPath, dir) => {
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
    await step(
      run,
      ['d1', 'migrations', 'apply', 'DB', '--remote', '--config', configPath],
      env,
      'applying D1 migrations',
    );
    await step(run, ['deploy', '--config', configPath], env, 'wrangler deploy');
  });
  if (dryRun) return;
  log(`waiting for https://${org.hub.hostname}/ to answer`);
  await wait(org.hub.hostname);
  log(`deployed: https://${org.hub.hostname}/`);
};

export const SECRET_NAMES = ['GITHUB_READ_TOKEN', 'GITHUB_WRITE_TOKEN'] as const;

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
