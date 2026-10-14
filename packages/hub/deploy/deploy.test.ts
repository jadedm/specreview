import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cloudflare } from './cloudflare';
import { deploy, runWrangler, secret, waitForHost, type Run } from './deploy';
import { hubProblems, loadOrg } from './org';
import { HUB_DIR, parseJsonc, pinned, wranglerConfig } from './wrangler-config';
import { CONFIG, emptyAccount, fakeCloudflare, orgDir, TOKEN } from './test-helpers';

const EXAMPLE = path.join(HUB_DIR, '..', '..', 'examples', 'org');
// examples/org is the blank template (#55); this is the same org after setup.
const exampleHub = () =>
  JSON.parse(readFileSync(path.join(HUB_DIR, 'deploy', 'fixtures', 'finished-hub.json'), 'utf8')) as Record<
    string,
    unknown
  >;
// The example organisation folder as it is once setup has run.
const finishedExample = () =>
  orgDir(exampleHub(), JSON.parse(readFileSync(path.join(EXAMPLE, 'specreview.config.json'), 'utf8'))).dir;

// Records each wrangler call with the generated config as it was at the time.
const recorder = (codes: number[] = []) => {
  const calls: { args: string[]; env: NodeJS.ProcessEnv; input?: string; config: string }[] = [];
  const run: Run = async (args, { env, input }) => {
    const at = args.indexOf('--config');
    calls.push({ args, env, input, config: readFileSync(args[at + 1], 'utf8') });
    return codes.shift() ?? 0;
  };
  return { run, calls };
};
const noWait = async () => 'resolver' as const;
// Cloudflare as deploy asks it about the hub key (#56): the Worker exists
// and, unless told otherwise, already has the key.
const cfFor = (tokenFile: string, secrets: string[] = ['SPECREVIEW_KEY']) => {
  const state = emptyAccount();
  state.scripts = ['specreview-hub'];
  state.secrets = { 'specreview-hub': secrets };
  return cloudflare(tokenFile, fakeCloudflare(state).fetchImpl);
};

describe('9: the organisation folder', () => {
  it('3: hub.json problems are named', () => {
    const bad: [Record<string, unknown>, RegExp][] = [
      [{ accountId: 'abc' }, /accountId must be/],
      [{ hostname: 'https://specs.acme.dev' }, /hostname must be a bare/],
      [{ hostname: 'specs.acme.dev:8443' }, /hostname must be a bare/],
      [{ hostname: 'specs.acme.dev/docs' }, /hostname must be a bare/],
      [{ worker: 'Specreview_Hub' }, /worker must be/],
      [{ database: { name: 'specreview', id: 'nope' } }, /database.id/],
      [{ bucket: { name: 'x' } }, /bucket.name/],
      [{ bucket: { name: 'specreview-sites', created: false } }, /bucket.created/],
      [{ access: { aud: '' } }, /access.aud is malformed/],
      [{ extra: 1 }, /unknown key extra/],
    ];
    for (const [change, why] of bad)
      expect(hubProblems({ ...exampleHub(), ...change }).join('\n'), JSON.stringify(change)).toMatch(why);
    expect(hubProblems(exampleHub())).toEqual([]);
  });

  it('4: Access fields in specreview.config.json are refused', () => {
    const { dir } = orgDir(exampleHub(), { ...CONFIG, accessAud: 'x' });
    expect(() => loadOrg(dir)).toThrow(/sets accessAud; it belongs in hub.json/);
  });

  it('1, 25 and 26: the generated config is complete, uses absolute paths and the pinned date', () => {
    const cfg = wranglerConfig(loadOrg(finishedExample()));
    const hub = exampleHub() as { accountId: string; access: { teamDomain: string; aud: string } };
    expect(cfg).toMatchObject({
      name: 'specreview-hub',
      account_id: hub.accountId,
      workers_dev: false,
      preview_urls: false,
      routes: [{ pattern: 'specs.acme.dev', custom_domain: true }],
      r2_buckets: [{ binding: 'SITES', bucket_name: 'specreview-sites' }],
      d1_databases: [
        { binding: 'DB', database_name: 'specreview', database_id: '00000000-0000-0000-0000-000000000000' },
      ],
    });
    expect(path.isAbsolute(cfg.main) && cfg.main === path.join(HUB_DIR, 'src', 'index.ts')).toBe(true);
    expect(cfg.d1_databases[0].migrations_dir).toBe(path.join(HUB_DIR, 'migrations'));
    const source = parseJsonc(readFileSync(path.join(HUB_DIR, 'wrangler.jsonc'), 'utf8')) as {
      compatibility_date: string;
      triggers: unknown;
    };
    expect(cfg.compatibility_date).toBe(source.compatibility_date);
    expect(cfg.triggers).toEqual(source.triggers);
    const merged = JSON.parse(cfg.vars.SPECREVIEW_CONFIG) as Record<string, unknown>;
    expect(merged).toEqual({
      ...JSON.parse(readFileSync(path.join(EXAMPLE, 'specreview.config.json'), 'utf8')),
      accessTeamDomain: hub.access.teamDomain,
      accessAud: hub.access.aud,
    });
  });

  it('2: a config the hub would refuse stops deploy before wrangler runs', async () => {
    const config = structuredClone(CONFIG);
    config.sites[0].approvers = ['pm@elsewhere.dev'];
    const { dir, tokenFile } = orgDir(exampleHub(), config);
    const { run, calls } = recorder();
    await expect(
      deploy({ org: loadOrg(dir), tokenFile, cf: cfFor(tokenFile), run, log: () => {}, dryRun: false, wait: noWait }),
    ).rejects.toThrow(/approvers has an email outside/);
    expect(calls).toEqual([]);
  });

  it('a hub.json setup has not finished is refused', async () => {
    const { dir, tokenFile } = orgDir();
    const { run, calls } = recorder();
    await expect(
      deploy({ org: loadOrg(dir), tokenFile, cf: cfFor(tokenFile), run, log: () => {}, dryRun: false, wait: noWait }),
    ).rejects.toThrow(/run setup with --apply first; hub.json lacks database.id, bucket.created, access.teamDomain/);
    expect(calls).toEqual([]);
  });

  it('parseJsonc keeps // inside strings and drops comments and trailing commas', () => {
    expect(parseJsonc('{\n // c\n "a": "http://x", /* b */ "b": [1,2,],\n}')).toEqual({ a: 'http://x', b: [1, 2] });
    expect(pinned().triggers.crons.length).toBeGreaterThan(0);
  });
});

describe('9: deploy', () => {
  it('5 and 6: migrations then deploy, the token only in the environment', async () => {
    const { dir, tokenFile } = orgDir(exampleHub());
    const { run, calls } = recorder();
    const lines: string[] = [];
    await deploy({
      org: loadOrg(dir),
      tokenFile,
      cf: cfFor(tokenFile),
      run,
      log: (l) => lines.push(l),
      dryRun: false,
      wait: noWait,
    });
    expect(calls.map((c) => c.args[0])).toEqual(['d1', 'deploy']);
    expect(calls[0].args.slice(0, 4)).toEqual(['d1', 'migrations', 'apply', 'DB']);
    expect(calls[1].args).toEqual(['deploy', '--config', expect.any(String)]);
    expect(calls[0].args).toContain('--remote');
    for (const c of calls) {
      expect(c.env.CLOUDFLARE_API_TOKEN).toBe(TOKEN);
      expect(c.env.CLOUDFLARE_ACCOUNT_ID).toBe(exampleHub().accountId);
      expect(c.args.join(' ')).not.toContain(TOKEN);
      expect(c.config).not.toContain(TOKEN);
    }
    expect(lines.join('\n')).not.toContain(TOKEN);
    expect(lines.at(-1)).toBe('deployed: https://specs.acme.dev/');
  });

  it('15 (#56): a Worker without the hub key gets one, on stdin, never printed; one that has it is left alone', async () => {
    const { dir, tokenFile } = orgDir(exampleHub());
    const { run, calls } = recorder();
    const lines: string[] = [];
    const cf = cfFor(tokenFile, []);
    await deploy({ org: loadOrg(dir), tokenFile, cf, run, log: (l) => lines.push(l), dryRun: false, wait: noWait });
    expect(calls.map((c) => c.args[0])).toEqual(['d1', 'deploy', 'secret']);
    expect(calls[2].args).toEqual(['secret', 'put', 'SPECREVIEW_KEY', '--config', expect.any(String)]);
    const key = calls[2].input ?? '';
    expect(Buffer.from(key, 'base64')).toHaveLength(32);
    expect(calls[2].args.join(' ') + lines.join('\n') + calls[2].config).not.toContain(key);
    expect(lines).toContain('hub key set');
    const again = recorder();
    await deploy({
      org: loadOrg(dir),
      tokenFile,
      cf: cfFor(tokenFile),
      run: again.run,
      log: () => {},
      dryRun: false,
      wait: noWait,
    });
    expect(again.calls.map((c) => c.args[0])).toEqual(['d1', 'deploy']);
  });

  it('15 (#56): a key put that reports failure after setting the key is not followed by a second key', async () => {
    const { dir, tokenFile } = orgDir(exampleHub());
    await expect(
      deploy({
        org: loadOrg(dir),
        tokenFile,
        cf: cfFor(tokenFile, []),
        run: recorder([0, 0, 1]).run,
        log: () => {},
        dryRun: false,
        wait: noWait,
      }),
    ).rejects.toThrow(/setting the hub key failed/);
    // Cloudflare has the key after all: the rerun asks, and leaves it.
    const again = recorder();
    await deploy({
      org: loadOrg(dir),
      tokenFile,
      cf: cfFor(tokenFile),
      run: again.run,
      log: () => {},
      dryRun: false,
      wait: noWait,
    });
    expect(again.calls.map((c) => c.args[0])).toEqual(['d1', 'deploy']);
  });

  it('15 (#56): if Cloudflare cannot say whether the key exists, no key is set and deploy fails', async () => {
    const { dir, tokenFile } = orgDir(exampleHub());
    const state = emptyAccount();
    const { run, calls } = recorder();
    await expect(
      deploy({
        org: loadOrg(dir),
        tokenFile,
        cf: cloudflare(tokenFile, fakeCloudflare(state).fetchImpl),
        run,
        log: () => {},
        dryRun: false,
        wait: noWait,
      }),
    ).rejects.toThrow(/script not found/);
    expect(calls.map((c) => c.args[0])).toEqual(['d1', 'deploy']);
  });

  it('5 and 28: a failing step stops the rest; a rerun applies and deploys again', async () => {
    const { dir, tokenFile } = orgDir(exampleHub());
    const first = recorder([0, 1]);
    await expect(
      deploy({
        org: loadOrg(dir),
        tokenFile,
        cf: cfFor(tokenFile),
        run: first.run,
        log: () => {},
        dryRun: false,
        wait: noWait,
      }),
    ).rejects.toThrow(/wrangler deploy failed \(wrangler exit 1\)/);
    const migrationsFail = recorder([7]);
    await expect(
      deploy({
        org: loadOrg(dir),
        tokenFile,
        cf: cfFor(tokenFile),
        run: migrationsFail.run,
        log: () => {},
        dryRun: false,
        wait: noWait,
      }),
    ).rejects.toThrow(/applying D1 migrations failed \(wrangler exit 7\); nothing after it ran/);
    expect(migrationsFail.calls).toHaveLength(1);
    const again = recorder();
    await deploy({
      org: loadOrg(dir),
      tokenFile,
      cf: cfFor(tokenFile),
      run: again.run,
      log: () => {},
      dryRun: false,
      wait: noWait,
    });
    expect(again.calls).toHaveLength(2);
  });

  it('7: an unreadable or empty token file is refused before wrangler runs', async () => {
    const { dir, tokenFile } = orgDir(exampleHub());
    writeFileSync(tokenFile, '\n');
    const { run, calls } = recorder();
    await expect(
      deploy({ org: loadOrg(dir), tokenFile, cf: cfFor(tokenFile), run, log: () => {}, dryRun: false, wait: noWait }),
    ).rejects.toThrow(/--token-file must name a readable file/);
    await expect(
      deploy({
        org: loadOrg(dir),
        tokenFile: path.join(dir, 'missing'),
        run,
        log: () => {},
        dryRun: false,
        wait: noWait,
      }),
    ).rejects.toThrow(/--token-file/);
    expect(calls).toEqual([]);
  });

  // The nameserver path finds nothing, so only the system path is tested here.
  const notThere = async () => false;

  it('29: waits for the Access redirect, through DNS failures and Cloudflare error pages, and times out with a reason', async () => {
    const answers = [
      () => Promise.reject(new Error('ENOTFOUND')),
      () => Promise.resolve(new Response('origin unreachable', { status: 530 })),
      () => Promise.resolve(new Response('not routed', { status: 404 })),
      () =>
        Promise.resolve(new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/login' } })),
      () =>
        Promise.resolve(
          new Response(null, { status: 302, headers: { location: 'https://another-team.cloudflareaccess.com/login' } }),
        ),
      () =>
        Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: 'https://acme.cloudflareaccess.com/cdn-cgi/access/login/specs.acme.dev' },
          }),
        ),
    ];
    let n = 0;
    const provisioning = (() => answers[n++]()) as typeof fetch;
    await waitForHost('specs.acme.dev', 'acme.cloudflareaccess.com', {
      fetchImpl: provisioning,
      direct: notThere,
      tries: 10,
      delayMs: 1,
    });
    expect(n).toBe(6);
    const never = (async () => {
      throw new Error('ENOTFOUND');
    }) as typeof fetch;
    await expect(
      waitForHost('specs.acme.dev', 'acme.cloudflareaccess.com', {
        fetchImpl: never,
        direct: notThere,
        tries: 3,
        delayMs: 1,
      }),
    ).rejects.toThrow(/did not answer within 0 s; DNS or the certificate/);
  });

  it('27 (1, 2, 10): the nameserver path is asked only when the system path fails, on every poll', async () => {
    const fails = (async () => {
      throw new Error('ENOTFOUND');
    }) as typeof fetch;
    const answers = [false, false, true];
    let asked = 0;
    const direct = async () => answers[asked++];
    await waitForHost('specs.acme.dev', 'acme.cloudflareaccess.com', {
      fetchImpl: fails,
      direct,
      tries: 5,
      delayMs: 1,
    });
    expect(asked).toBe(3);
    asked = 0;
    const redirects = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://acme.cloudflareaccess.com/cdn-cgi/access/login/specs.acme.dev' },
      })) as typeof fetch;
    await waitForHost('specs.acme.dev', 'acme.cloudflareaccess.com', {
      fetchImpl: redirects,
      direct,
      tries: 1,
      delayMs: 1,
    });
    expect(asked).toBe(0);
  });

  it('27 (12): the timeout says the Worker is deployed and how to check and flush the resolver', async () => {
    const fails = (async () => {
      throw new Error('ENOTFOUND');
    }) as typeof fetch;
    const err = await waitForHost('specs.acme.dev', 'acme.cloudflareaccess.com', {
      fetchImpl: fails,
      direct: notThere,
      tries: 2,
      delayMs: 1,
    }).then(
      () => new Error('the wait returned'),
      (e: unknown) => e as Error,
    );
    expect(err.message).toContain('The Worker is deployed.');
    expect(err.message).toContain('`dig +trace specs.acme.dev`');
    expect(err.message).toContain('sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder');
    expect(err.message).toContain('resolvectl flush-caches');
  });

  it('27 (review): a nameserver check that hangs is cut off at its budget', async () => {
    const fails = (async () => {
      throw new Error('ENOTFOUND');
    }) as typeof fetch;
    const hangs = () => new Promise<boolean>(() => {});
    const started = Date.now();
    await expect(
      waitForHost('specs.acme.dev', 'acme.cloudflareaccess.com', {
        fetchImpl: fails,
        direct: hangs,
        directBudgetMs: 20,
        tries: 3,
        delayMs: 1,
      }),
    ).rejects.toThrow(/did not answer within 0 s/);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('27 (review): a hub found only through its nameservers is reported with the flush advice', async () => {
    const { dir, tokenFile } = orgDir(exampleHub());
    const lines: string[] = [];
    const deployOnce = (wait: () => Promise<'resolver' | 'nameservers'>) =>
      deploy({
        org: loadOrg(dir),
        tokenFile,
        cf: cfFor(tokenFile),
        run: recorder().run,
        log: (l) => lines.push(l),
        dryRun: false,
        wait,
      });
    await deployOnce(async () => 'nameservers');
    expect(lines.some((l) => l.includes("this machine's resolver did not find") && l.includes('dig +trace'))).toBe(
      true,
    );
    lines.length = 0;
    await deployOnce(noWait);
    expect(lines.some((l) => l.includes('dig +trace'))).toBe(false);
  });

  it(
    '1, 15, 25 and 27: a real dry run of examples/org builds from another directory with no network',
    { timeout: 120_000 },
    async () => {
      const saved = { cwd: process.cwd(), env: { ...process.env } };
      const closed = 'http://127.0.0.1:9';
      Object.assign(process.env, {
        HTTPS_PROXY: closed,
        HTTP_PROXY: closed,
        https_proxy: closed,
        http_proxy: closed,
        ALL_PROXY: closed,
        WRANGLER_SEND_METRICS: 'false',
      });
      process.chdir(tmpdir());
      const lines: string[] = [];
      const ran: number[] = [];
      const real = runWrangler();
      try {
        await deploy({
          org: loadOrg(finishedExample()),
          tokenFile: '',
          run: async (args, opts) => {
            const code = await real(args, opts);
            ran.push(code);
            return code;
          },
          log: (l) => lines.push(l),
          dryRun: true,
        });
      } finally {
        process.chdir(saved.cwd);
        process.env = saved.env;
      }
      expect(ran).toEqual([0]);
      expect(lines).toEqual(['dry run passed: the hub builds with this configuration']);
    },
  );
});

describe('9: secret', () => {
  const setUp = (scripts: string[], value: string) => {
    const { dir, tokenFile } = orgDir(exampleHub());
    const valueFile = path.join(dir, 'value');
    writeFileSync(valueFile, value);
    const state = emptyAccount();
    state.scripts = scripts;
    const fake = fakeCloudflare(state);
    return { org: loadOrg(dir), tokenFile, valueFile, cf: cloudflare(tokenFile, fake.fetchImpl) };
  };

  it('14 and 30: pipes the value on stdin without its trailing newline; never in arguments or output', async () => {
    const s = setUp(['specreview-hub'], 'ghp-secret-value\n');
    const { run, calls } = recorder();
    const lines: string[] = [];
    await secret({ ...s, run, log: (l) => lines.push(l), name: 'GITHUB_READ_TOKEN' });
    expect(calls).toHaveLength(1);
    expect(calls[0].args.slice(0, 3)).toEqual(['secret', 'put', 'GITHUB_READ_TOKEN']);
    expect(calls[0].input).toBe('ghp-secret-value');
    expect(calls[0].env.CLOUDFLARE_API_TOKEN).toBe(TOKEN);
    expect(calls[0].args.join(' ') + lines.join('\n') + calls[0].config).not.toMatch(/ghp-secret-value|cf-test-token/);
  });

  it('12 (#6): takes the app id and the multi-line private key, the key intact on stdin and nowhere else', async () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD9\n-----END RSA PRIVATE KEY-----\n';
    const s = setUp(['specreview-hub'], pem);
    const { run, calls } = recorder();
    const lines: string[] = [];
    await secret({ ...s, run, log: (l) => lines.push(l), name: 'GITHUB_APP_PRIVATE_KEY' });
    await secret({ ...s, run, log: (l) => lines.push(l), name: 'GITHUB_APP_ID' });
    expect(calls.map((c) => c.args[2])).toEqual(['GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_ID']);
    expect(calls[0].input).toBe(pem.slice(0, -1));
    expect(calls[0].args.join(' ') + lines.join('\n') + calls[0].config).not.toMatch(/MIIBOgIBAAJBAKj34GkxFhD9/);
  });

  it('30: refuses before the first deploy, an empty value, and other names', async () => {
    const { run, calls } = recorder();
    await expect(secret({ ...setUp([], 'x'), run, log: () => {}, name: 'GITHUB_READ_TOKEN' })).rejects.toThrow(
      /does not exist yet; deploy first/,
    );
    await expect(
      secret({ ...setUp(['specreview-hub'], '\n'), run, log: () => {}, name: 'GITHUB_READ_TOKEN' }),
    ).rejects.toThrow(/--value-file is empty/);
    await expect(
      secret({ ...setUp(['specreview-hub'], 'x'), run, log: () => {}, name: 'SPECREVIEW_CONFIG' }),
    ).rejects.toThrow(/--name must be one of/);
    expect(calls).toEqual([]);
  });
});
