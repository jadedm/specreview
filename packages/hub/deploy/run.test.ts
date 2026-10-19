import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { HUB_DIR } from './wrangler-config';

// The template's run.sh (#92, check-docs), run for real with git, pnpm and
// node replaced on PATH by stubs that log their arguments one per line: the
// real ones would clone and build specreview from GitHub. The stub node
// writes into the folder after --out and exits as STUB_NODE says.
const TEMPLATE = path.join(HUB_DIR, '..', '..', 'examples', 'org');
const COMMIT = 'a'.repeat(40);
// An endpoint scanner can hold a fresh script for tens of seconds (apply.test.ts).
vi.setConfig({ testTimeout: 180_000 });

const STUBS: Record<string, string> = {
  git: `[ "$2" = clone ] || [ "$1" = clone ] && exit 0
for a in "$@"; do [ "$a" = branch ] && { echo "  origin/develop"; exit 0; }; done
# A release tag only for exactly: tag --points-at <the pinned commit> --list v*
[ "$3 $4 $5 $6 $7" = "tag --points-at ${COMMIT} --list v*" ] && { [ -n "\${STUB_TAG:-}" ] && printf '%s\\n' $STUB_TAG; exit 0; }
exit 0`,
  pnpm: `echo "pnpm $*" >> "$STUB_LOG"`,
  node: `{ echo "node cwd=$PWD"; for a in "$@"; do echo "arg $a"; done; } >> "$STUB_LOG"
prev=""; for a in "$@"; do [ "$prev" = --out ] && { mkdir -p "$a"; echo built > "$a/marker"; }; prev=$a; done
exit "\${STUB_NODE:-0}"`,
};

const setup = () => {
  // Real path: run.sh resolves the product folder with pwd, past /var -> /private/var.
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'specreview-run-')));
  const org = path.join(root, 'org');
  cpSync(TEMPLATE, org, { recursive: true });
  writeFileSync(path.join(org, 'specreview.commit'), `${COMMIT}\n`);
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(path.join(bin, name), 0o755);
  }
  const product = path.join(root, 'product');
  mkdirSync(product);
  const log = path.join(root, 'stub.log');
  const run = (args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync('bash', [path.join(org, 'run.sh'), ...args], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STUB_LOG: log, ...env },
    });
    return { code: r.status, out: r.stdout, err: r.stderr, log: existsSync(log) ? readFileSync(log, 'utf8') : '' };
  };
  return { root, org, product, run, out: path.join(product, '.specreview-check') };
};

const argsOf = (log: string) =>
  log
    .split('\n')
    .filter((l) => l.startsWith('arg '))
    .map((l) => l.slice(4));

describe('92: run.sh check-docs', () => {
  it('15 and the plan review: builds the site package and passes every option through as its own argument', () => {
    const t = setup();
    const r = t.run(
      [
        'check-docs',
        'product',
        '--repo',
        'product',
        '--docs',
        'spec docs',
        '--exclude',
        'drafts/**',
        '--exclude',
        'old.md',
        '--prototypes',
        'proto',
      ],
      { STUB_TAG: 'v0.1.0' },
    );
    expect([r.code, r.err]).toEqual([0, 'run.sh: specreview v0.1.0\n']);
    expect(r.out).toContain('check-docs: the docs build; nothing was published');
    expect(r.log).toContain('pnpm --filter @specreview/site build');
    expect(r.log).not.toContain('@specreview/hub build');
    expect(r.log).toContain(`node cwd=${t.product}`);
    const args = argsOf(r.log);
    expect(args.slice(0, 1)[0]).toMatch(/packages\/site\/dist\/build\/cli\.js$/);
    expect(args.slice(1)).toEqual([
      'build',
      '--repo',
      'product',
      '--docs',
      'spec docs',
      '--exclude',
      'drafts/**',
      '--exclude',
      'old.md',
      '--prototypes',
      'proto',
      '--out',
      t.out,
    ]);
    // The stub wrote there; run.sh deleted it.
    expect(existsSync(t.out)).toBe(false);
  });

  it('16: a failing build exits non-zero, prints no success line and still deletes its folder', () => {
    const t = setup();
    const r = t.run(['check-docs', 'product', '--repo', 'product'], { STUB_NODE: '1' });
    expect(r.code).toBe(1);
    expect(r.out).not.toContain('nothing was published');
    expect(existsSync(t.out)).toBe(false);
  });

  it('17: a folder already at .specreview-check is refused and left as it was', () => {
    const t = setup();
    mkdirSync(t.out);
    writeFileSync(path.join(t.out, 'keep'), 'mine');
    const r = t.run(['check-docs', 'product', '--repo', 'product']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('already exists');
    expect(readFileSync(path.join(t.out, 'keep'), 'utf8')).toBe('mine');
    expect(r.log).toBe('');
  });

  it('review: a dangling symlink at .specreview-check is refused and left in place', () => {
    const t = setup();
    symlinkSync(path.join(t.root, 'nowhere'), t.out);
    const r = t.run(['check-docs', 'product', '--repo', 'product']);
    expect(r.code).toBe(2);
    expect(lstatSync(t.out).isSymbolicLink()).toBe(true);
    expect(r.log).toBe('');
  });

  it('review: a CDPATH in the environment changes no path', () => {
    const t = setup();
    const r = t.run(['check-docs', 'product', '--repo', 'product'], { CDPATH: t.root });
    expect(r.code).toBe(0);
    expect(argsOf(r.log).at(-1)).toBe(t.out);
    expect(existsSync(t.out)).toBe(false);
  });

  it('18: no product folder, or one that does not exist, prints the usage', () => {
    const t = setup();
    for (const args of [['check-docs'], ['check-docs', 'missing', '--repo', 'x']]) {
      const r = t.run(args);
      expect(r.code).toBe(2);
      expect(r.err).toContain('usage: ./run.sh check-docs');
    }
  });

  it('review: PRODUCT and OUT from the environment neither switch the command nor delete anything', () => {
    const t = setup();
    const keep = path.join(t.root, 'keep');
    mkdirSync(keep);
    writeFileSync(path.join(keep, 'file'), 'mine');
    const r = t.run(['setup', '--token-file', '/nonexistent'], { PRODUCT: t.product, OUT: keep });
    expect(r.code).toBe(0);
    expect(r.log).toContain('pnpm --filter @specreview/hub build');
    expect(r.log).not.toContain('@specreview/site build');
    expect(readFileSync(path.join(keep, 'file'), 'utf8')).toBe('mine');
  });

  it('#84 (1, 3): a release commit is named, for every command', () => {
    const t = setup();
    for (const args of [
      ['setup', '--token-file', '/x'],
      ['check-docs', 'product', '--repo', 'product'],
    ]) {
      const r = t.run(args, { STUB_TAG: 'v0.1.0' });
      expect([r.code, r.err], args[0]).toEqual([0, 'run.sh: specreview v0.1.0\n']);
    }
  });

  it('#84 review: with two release tags on the commit, one is named', () => {
    const r = setup().run(['setup', '--token-file', '/x'], { STUB_TAG: 'v0.1.0 v0.1.1' });
    expect([r.code, r.err]).toEqual([0, 'run.sh: specreview v0.1.0\n']);
  });

  it('#84 (2): a commit no release tag points to runs, with one warning line', () => {
    const t = setup();
    const r = t.run(['setup', '--token-file', '/x']);
    expect(r.code).toBe(0);
    expect(r.err).toBe(`run.sh: ${COMMIT} is not a specreview release; pin the commit a release tag points to\n`);
    expect(r.log).toContain('deploy.mjs');
    const failing = t.run(['check-docs', 'product', '--repo', 'product'], { STUB_NODE: '3' });
    expect(failing.code).toBe(3);
  });

  it('19: other commands still build the hub and pass --org', () => {
    for (const command of ['setup', 'deploy', 'secret', 'workflow-token']) {
      const t = setup();
      const r = t.run([command, '--token-file', '/nonexistent']);
      expect(r.code, command).toBe(0);
      expect(r.log, command).toContain('pnpm --filter @specreview/hub build');
      expect(r.log, command).not.toContain('@specreview/site build');
      const args = argsOf(r.log);
      expect(args[0], command).toMatch(/packages\/hub\/dist\/deploy\.mjs$/);
      expect(args.slice(1), command).toEqual([command, '--token-file', '/nonexistent', '--org', t.org]);
    }
  });
});
