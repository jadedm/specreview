// node packages/hub/dist/deploy.mjs <setup|deploy|secret> --org <dir> --token-file <file> [...]
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudflare, readToken } from './cloudflare';
import { deploy, runWrangler, secret } from './deploy';
import { DeployError, loadOrg } from './org';
import { setup } from './setup';

const USAGE = `usage:
  deploy.mjs setup  --org <dir> --token-file <file> [--apply]
  deploy.mjs deploy --org <dir> --token-file <file> [--dry-run]
  deploy.mjs secret --org <dir> --token-file <file> --name GITHUB_READ_TOKEN|GITHUB_WRITE_TOKEN --value-file <file>`;

const FLAGS = new Set(['--apply', '--dry-run']);
const OPTIONS = new Set(['--org', '--token-file', '--name', '--value-file']);

export const parseArgs = (argv: string[]) => {
  const [command, ...rest] = argv;
  const flags = new Set<string>();
  const options = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (FLAGS.has(arg)) flags.add(arg);
    else if (OPTIONS.has(arg) && rest[i + 1] !== undefined) options.set(arg, rest[++i]);
    else throw new DeployError(`unknown or incomplete argument: ${arg}\n${USAGE}`);
  }
  if (!['setup', 'deploy', 'secret'].includes(command ?? '')) throw new DeployError(USAGE);
  const need = (name: string) => {
    const v = options.get(name);
    if (!v) throw new DeployError(`${command} needs ${name}\n${USAGE}`);
    return v;
  };
  return { command, flags, options, need };
};

export const main = async (
  argv: string[],
  log: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
) => {
  const { command, flags, need } = parseArgs(argv);
  const org = loadOrg(path.resolve(need('--org')));
  const dryRun = flags.has('--dry-run');
  // A dry run builds without calling Cloudflare, so it needs no token; every
  // other command checks the token file before doing anything.
  const tokenFile = command === 'deploy' && dryRun ? '' : need('--token-file');
  if (tokenFile) readToken(tokenFile);
  const run = runWrangler();
  if (command === 'setup') return setup(org, cloudflare(tokenFile), { apply: flags.has('--apply'), log });
  if (command === 'deploy') return deploy({ org, tokenFile, run, log, dryRun });
  return secret({
    org,
    tokenFile,
    run,
    log,
    cf: cloudflare(tokenFile),
    name: need('--name'),
    valueFile: need('--value-file'),
  });
};

// Compared as real paths: a URL keeps spaces escaped and a symlinked folder
// resolves differently, and either would make the script exit without running.
export const isEntry = (argv1: string | undefined, moduleUrl: string) => {
  const real = (p: string) => (existsSync(p) ? realpathSync(p) : path.resolve(p));
  return Boolean(argv1) && real(argv1 as string) === real(fileURLToPath(moduleUrl));
};
const invoked = isEntry(process.argv[1], import.meta.url);
if (invoked) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(e instanceof DeployError ? e.message : e);
    process.exit(1);
  });
}
