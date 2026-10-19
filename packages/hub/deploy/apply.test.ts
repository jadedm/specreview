import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadOrg } from './org';
import { HUB_DIR } from './wrangler-config';

// examples/org is the template an organisation's hub repo starts from (#55).
// These run its apply.sh for real, in throwaway repos: a bare repo stands in
// for GitHub, and a stub run.sh logs what it was given and does what the case
// says (STUB_SETUP, STUB_DEPLOY).
const TEMPLATE = path.join(HUB_DIR, '..', '..', 'examples', 'org');
const TOKEN = 'cf-secret-7f3a9c';
// Each case starts scripts copied into fresh folders; an endpoint scanner can
// hold those for tens of seconds before they run. A script still running
// after SCRIPT_LIMIT_MS is killed, so a real hang fails the case.
const SCRIPT_LIMIT_MS = 90_000;
vi.setConfig({ testTimeout: 4 * SCRIPT_LIMIT_MS });

const STUB = `#!/usr/bin/env bash
set -u
# Commits in OTHER are a person's, not the bot identity apply.sh exports.
person() { env -u GIT_AUTHOR_NAME -u GIT_AUTHOR_EMAIL -u GIT_COMMITTER_NAME -u GIT_COMMITTER_EMAIL git -C "$OTHER" "$@"; }
cmd=$1
tf=""
prev=""
for a in "$@"; do [ "$prev" = --token-file ] && tf=$a; prev=$a; done
mode=$(stat -c %a "$tf" 2>/dev/null || stat -f %Lp "$tf")
echo "$cmd mode=$mode file=$tf token=$(cat "$tf") env=\${CLOUDFLARE_API_TOKEN:-none} args=$* hub=$(tr -d '\\n ' < hub.json)" >> "$STUB_LOG"
what=$([ "$cmd" = setup ] && echo "\${STUB_SETUP:-ok}" || echo "\${STUB_DEPLOY:-ok}")
case "$what" in
  ok) exit 0 ;;
  fail) exit 3 ;;
  write) echo "{\\"by\\":\\"$cmd\\"}" > hub.json; exit 0 ;;
  write-fail) echo "{\\"by\\":\\"$cmd\\"}" > hub.json; exit 4 ;;
  write-other) echo "{\\"by\\":\\"$cmd\\"}" > hub.json; echo changed >> specreview.config.json; exit 0 ;;
  origin-has-setup) git --git-dir="$ORIGIN" show main:hub.json | grep -q '"by":"setup"' && echo "deploy saw setup on origin" >> "$STUB_LOG"; exit 0 ;;
  race) person commit -q --allow-empty -m "chore: a push during the run" && person push -q origin main
        echo "{\\"by\\":\\"$cmd\\"}" > hub.json; exit 0 ;;
  race-config) echo '{"sites":["new"]}' > "$OTHER/specreview.config.json" && person commit -q -am "chore: a config change during the run" && person push -q origin main
        echo "{\\"by\\":\\"$cmd\\"}" > hub.json; exit 0 ;;
  reject) touch "$ORIGIN/reject"; echo "{\\"by\\":\\"$cmd\\"}" > hub.json; exit 0 ;;
  conflict) echo '{"by":"a person"}' > "$OTHER/hub.json" && person commit -q -am "chore: edit hub.json" && person push -q origin main
            echo "{\\"by\\":\\"$cmd\\",\\"id\\":\\"d1-uuid\\"}" > hub.json; exit 0 ;;
esac
`;

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// origin (bare, main), a clone the run happens in, and a second clone that
// pushes "during" the run.
const hubRepo = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'specreview-apply-'));
  const origin = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  writeFileSync(
    path.join(origin, 'hooks', 'pre-receive'),
    '#!/usr/bin/env bash\n[ -e "$(dirname "$0")/../reject" ] && { echo refused; exit 1; }\nexit 0\n',
  );
  chmodSync(path.join(origin, 'hooks', 'pre-receive'), 0o755);
  cpSync(TEMPLATE, seed, { recursive: true });
  writeFileSync(path.join(seed, 'run.sh'), STUB);
  chmodSync(path.join(seed, 'run.sh'), 0o755);
  git(root, 'init', '-q', '-b', 'main', seed);
  git(seed, 'add', '-A');
  git(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'chore: start');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', 'origin', 'main');
  const work = path.join(root, 'work');
  const other = path.join(root, 'other');
  git(root, 'clone', '-q', origin, work);
  git(root, 'clone', '-q', origin, other);
  git(other, 'config', 'user.name', 'someone');
  git(other, 'config', 'user.email', 'someone@example.com');
  return { root, origin, work, other, log: path.join(root, 'stub.log') };
};

type Repo = ReturnType<typeof hubRepo>;
const apply = (repo: Repo, env: Record<string, string | undefined> = {}) => {
  const r = spawnSync('bash', ['apply.sh'], {
    cwd: repo.work,
    encoding: 'utf8',
    timeout: SCRIPT_LIMIT_MS,
    env: {
      PATH: process.env.PATH,
      HOME: repo.root,
      GITHUB_REF: 'refs/heads/main',
      CLOUDFLARE_API_TOKEN: TOKEN,
      STUB_LOG: repo.log,
      ORIGIN: repo.origin,
      OTHER: repo.other,
      GIT_CONFIG_NOSYSTEM: '1',
      // As on a fresh runner: no identity, and git may not guess one.
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'user.useConfigOnly',
      GIT_CONFIG_VALUE_0: 'true',
      ...env,
    },
  });
  const calls = existsSync(repo.log) ? readFileSync(repo.log, 'utf8').trim().split('\n') : [];
  if (r.error) throw r.error;
  return { code: r.status, out: `${r.stdout}${r.stderr}`, calls };
};
const originLog = (repo: Repo) => git(repo.origin, 'log', '--format=%an|%s', 'main').split('\n');
const originHub = (repo: Repo) => git(repo.origin, 'show', 'main:hub.json');

describe('1 and 9: the happy path', () => {
  it('runs setup --apply then deploy with one mode-600 token file, deleted after; the token is never printed', () => {
    const repo = hubRepo();
    const r = apply(repo);
    expect(r.code).toBe(0);
    expect(r.calls.map((c) => c.split(' ')[0])).toEqual(['setup', 'deploy']);
    const file = /file=(\S+)/.exec(r.calls[0])![1];
    for (const c of r.calls) {
      expect(c).toContain('mode=600');
      expect(c).toContain(`file=${file}`);
      expect(c).toContain(`token=${TOKEN}`);
      expect(c).toContain('env=none');
      expect(c.split('args=')[1].split(' hub=')[0]).not.toContain(TOKEN);
    }
    expect(r.calls[0]).toContain('args=setup --token-file');
    expect(r.calls[0]).toContain('--apply');
    expect(existsSync(file)).toBe(false);
    expect(r.out).not.toContain(TOKEN);
  });

  it('5: nothing changed: no commit, no push', () => {
    const repo = hubRepo();
    expect(apply(repo).code).toBe(0);
    expect(originLog(repo)).toEqual(['t|chore: start']);
  });
});

describe('2, 3 and 4: hub.json is saved after each step, whether or not it succeeded', () => {
  it('2: setup fails after recording ids: deploy does not run; hub.json is pushed; the failure is the exit code', () => {
    const repo = hubRepo();
    const r = apply(repo, { STUB_SETUP: 'write-fail' });
    expect(r.code).toBe(4);
    expect(r.calls.map((c) => c.split(' ')[0])).toEqual(['setup']);
    expect(originHub(repo)).toBe('{"by":"setup"}');
    expect(r.out).not.toContain(TOKEN);
  });

  it('2a: setup ids are on origin before deploy starts', () => {
    const repo = hubRepo();
    const r = apply(repo, { STUB_SETUP: 'write', STUB_DEPLOY: 'origin-has-setup' });
    expect(r.code).toBe(0);
    expect(r.calls).toContain('deploy saw setup on origin');
  });

  it('3: deploy fails after changing hub.json: pushed, and the failure is the exit code', () => {
    const repo = hubRepo();
    const r = apply(repo, { STUB_DEPLOY: 'write-fail' });
    expect(r.code).toBe(4);
    expect(originHub(repo)).toBe('{"by":"deploy"}');
  });

  it('4: each save is its own commit by the Actions bot with a conventional message', () => {
    const repo = hubRepo();
    expect(apply(repo, { STUB_SETUP: 'write', STUB_DEPLOY: 'write' }).code).toBe(0);
    expect(originLog(repo)).toEqual([
      'github-actions[bot]|chore(hub): record the deploy in hub.json',
      "github-actions[bot]|chore(hub): record setup's resources in hub.json",
      't|chore: start',
    ]);
  });

  it('10: only hub.json is committed; other changes stay out', () => {
    const repo = hubRepo();
    expect(apply(repo, { STUB_DEPLOY: 'write-other' }).code).toBe(0);
    expect(git(repo.origin, 'show', '--name-only', '--format=', 'main')).toBe('hub.json');
    expect(git(repo.origin, 'show', 'main:specreview.config.json')).not.toContain('changed');
  });
});

describe('6 and 6a: main moving', () => {
  it('6: a push during the run is rebased onto once; hub.json lands on top of it', () => {
    const repo = hubRepo();
    const r = apply(repo, { STUB_SETUP: 'race' });
    expect(r.code).toBe(0);
    expect(originLog(repo)).toEqual([
      "github-actions[bot]|chore(hub): record setup's resources in hub.json",
      'someone|chore: a push during the run',
      't|chore: start',
    ]);
    expect(originHub(repo)).toBe('{"by":"setup"}');
    // The push changed no file: what setup applied is what deploy deploys.
    expect(r.calls.map((c) => c.split(' ')[0])).toEqual(['setup', 'deploy']);
  });

  it('6c (#78): a rebase that brought a config change skips the deploy, left to the run that push queued', () => {
    const repo = hubRepo();
    const r = apply(repo, { STUB_SETUP: 'race-config' });
    expect(r.code).toBe(0);
    expect(r.calls.map((c) => c.split(' ')[0])).toEqual(['setup']);
    expect(r.out).toContain('the deploy is left to the run that push queued');
    expect(originLog(repo)[0]).toBe("github-actions[bot]|chore(hub): record setup's resources in hub.json");
    expect(originHub(repo)).toBe('{"by":"setup"}');
  });

  it('6: a push that still fails exits non-zero and prints hub.json, whose ids exist nowhere else', () => {
    const repo = hubRepo();
    const r = apply(repo, { STUB_SETUP: 'reject' });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(
      /could not push hub.json after setup's resources[^\n]*copy it into the repo by hand:\n\{"by":"setup"\}/,
    );
    expect(r.calls.map((c) => c.split(' ')[0])).toEqual(['setup']);
  });

  it("6b: a rebase that conflicts with a person editing hub.json prints the run's hub.json", () => {
    const repo = hubRepo();
    const r = apply(repo, { STUB_SETUP: 'conflict' });
    expect(r.code).toBe(1);
    // The run's own file, not the conflicted one on disk.
    expect(r.out.split('copy it into the repo by hand:\n')[1]).toBe('{"by":"setup","id":"d1-uuid"}\n');
    expect(r.out).not.toContain('<<<<<<<');
    expect(originHub(repo)).toBe('{"by":"a person"}');
    expect(r.calls.map((c) => c.split(' ')[0])).toEqual(['setup']);
  });

  it('6a: a run queued behind another applies the newest main, with the ids that run recorded', () => {
    const repo = hubRepo();
    writeFileSync(path.join(repo.other, 'hub.json'), '{"by":"the earlier run"}\n');
    git(repo.other, 'commit', '-q', '-am', 'chore(hub): record ids');
    git(repo.other, 'push', '-q', 'origin', 'main');
    const r = apply(repo);
    expect(r.code).toBe(0);
    expect(r.calls[0]).toContain('hub={"by":"theearlierrun"}');
  });
});

describe('7 and 8: refused before run.sh', () => {
  it.each([
    ['no token', { CLOUDFLARE_API_TOKEN: undefined }, /the CLOUDFLARE_API_TOKEN secret is not set/],
    ['an empty token', { CLOUDFLARE_API_TOKEN: '' }, /the CLOUDFLARE_API_TOKEN secret is not set/],
    [
      'another branch',
      { GITHUB_REF: 'refs/heads/feature/x' },
      /runs only on main \(GITHUB_REF is refs\/heads\/feature\/x\)/,
    ],
    ['no ref', { GITHUB_REF: undefined }, /runs only on main \(GITHUB_REF is unset\)/],
  ])('%s', (_name, env, message) => {
    const repo = hubRepo();
    const r = apply(repo, env);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(message);
    expect(r.calls).toEqual([]);
  });
});

describe('11: the workflow', () => {
  const yml = readFileSync(path.join(TEMPLATE, '.github', 'workflows', 'apply.yml'), 'utf8');
  const code = yml
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');

  it('runs on pushes to main and by hand, never for pull requests, and only on main', () => {
    expect(code).toMatch(/^on:\n {2}push:\n {4}branches: \[main\]\n {2}workflow_dispatch:\n\n/m);
    expect(code).not.toMatch(/pull_request|workflow_run|schedule|repository_dispatch/);
    expect(code).toContain("    if: github.ref == 'refs/heads/main'\n");
  });

  it('asks for contents: write and nothing else; one apply at a time, never cancelled', () => {
    expect(code).toMatch(/^permissions:\n {2}contents: write # apply.sh commits hub.json\n\n/m);
    expect(code.match(/permissions:/g)).toHaveLength(1);
    expect(code).toMatch(/^concurrency:\n {2}group: apply\n {2}cancel-in-progress: false\n/m);
  });

  it('pins every action to a full commit and gives the secret only to apply.sh', () => {
    const uses = code.match(/uses: \S+/g) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}$/);
    expect(code.match(/secrets\./g)).toHaveLength(1);
    expect(code).toMatch(
      /- run: \.\/apply\.sh\n {8}env:\n {10}CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}\n/,
    );
  });
});

describe('14: the template as a new organisation gets it', () => {
  it('hub.json records nothing setup writes, and loading it names what to fill in', () => {
    const hub = JSON.parse(readFileSync(path.join(TEMPLATE, 'hub.json'), 'utf8')) as Record<string, unknown>;
    expect(hub).toEqual({
      accountId: '',
      hostname: '',
      adminHostname: '',
      worker: 'specreview-hub',
      database: { name: 'specreview' },
      bucket: { name: 'specreview-sites' },
    });
    expect(() => loadOrg(TEMPLATE)).toThrow(/accountId must be[\s\S]*hostname must be[\s\S]*adminHostname must be/);
  });

  it('run.sh refuses the placeholder commit before cloning anything', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'specreview-template-'));
    cpSync(TEMPLATE, dir, { recursive: true });
    const r = spawnSync('bash', ['run.sh', 'setup', '--token-file', 'x'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: SCRIPT_LIMIT_MS,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('set specreview.commit to a full commit of jadedm/specreview');
    expect(existsSync(path.join(dir, '.specreview'))).toBe(false);
  });

  it('ignores the checkout run.sh makes, and apply.sh and run.sh are executable', () => {
    expect(readFileSync(path.join(TEMPLATE, '.gitignore'), 'utf8')).toBe('.specreview/\n');
    const mode = (f: string) => git(TEMPLATE, 'ls-files', '-s', f).split(' ')[0];
    expect(mode('run.sh')).toBe('100755');
    expect(mode('apply.sh')).toBe('100755');
  });
});
