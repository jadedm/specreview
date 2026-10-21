// The reusable workflow product repos call (#177), read as text: its inputs,
// what each job may do, and that the build and publish actions run from the
// workflow's own commit. Cases are the ticket's W rows.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const FILE = path.join(import.meta.dirname, '..', '..', '..', '.github', 'workflows', 'publish-docs.yml');
const text = readFileSync(FILE, 'utf8');
const lines = text.split('\n');
// The lines of one top-level key's block, or of one job.
const blockAfter = (header: RegExp) => {
  const start = lines.findIndex((l) => header.test(l));
  const indent = lines[start].length - lines[start].trimStart().length;
  const end = lines.findIndex(
    (l, i) => i > start && l.trim() && !l.trim().startsWith('#') && l.length - l.trimStart().length <= indent,
  );
  return lines.slice(start + 1, end === -1 ? undefined : end).filter((l) => l.trim() && !l.trim().startsWith('#'));
};
const job = (name: string) => blockAfter(new RegExp(`^  ${name}:$`));
// The libatomic step's lines after its name, comments left out (#185).
const LIBATOMIC = [
  '        shell: bash',
  '        run: |',
  '          if command -v dnf >/dev/null 2>&1; then',
  '            rpm -q libatomic >/dev/null 2>&1 || sudo -n dnf install -y -q libatomic',
  '          fi',
];

describe('177: the reusable publish workflow', () => {
  it('W1: it is only called, with exactly the six inputs', () => {
    const on = blockAfter(/^on:$/);
    expect(on.filter((l) => /^ {2}\S/.test(l))).toEqual(['  workflow_call:']);
    const inputs = blockAfter(/^ {4}inputs:$/).flatMap((l) => /^ {6}([a-z]+):$/.exec(l)?.[1] ?? []);
    expect(inputs).toEqual(['hub', 'repo', 'docs', 'exclude', 'prototypes', 'runner']);
    expect(text).not.toMatch(/secrets:/);
    // 185: a string of JSON, ubuntu-latest unless the caller names another.
    const runner = blockAfter(/^ {6}runner:$/);
    expect(runner.slice(1)).toEqual(['        type: string', `        default: '"ubuntu-latest"'`]);
  });

  it('W4, 185: both jobs run on the runner input, and nothing else names a machine', () => {
    for (const name of ['build', 'publish'])
      expect(
        job(name).filter((l) => l.includes('runs-on')),
        name,
      ).toEqual(['    runs-on: ${{ fromJSON(inputs.runner) }}']);
    expect(lines.filter((l) => /^\s+runs-on:/.test(l))).toHaveLength(2);
    // The steps are bash whatever the runner's own default shell is.
    expect(blockAfter(/^defaults:$/)).toEqual(['  run:', '    shell: bash']);
  });

  it('W1: its jobs are build and publish', () => {
    expect(blockAfter(/^jobs:$/).flatMap((l) => /^ {2}([a-z]+):$/.exec(l)?.[1] ?? [])).toEqual(['build', 'publish']);
  });

  it("W2: third-party actions are pinned by commit; ours run from this workflow's own commit", () => {
    const uses = lines.flatMap((l) => /^\s*(?:- )?uses: (\S+)/.exec(l)?.[1] ?? []);
    const ours = uses.filter((u) => u.startsWith('./'));
    expect(ours).toEqual(['./specreview-tool/build', './specreview-tool/publish']);
    for (const u of uses.filter((u) => !u.startsWith('./'))) expect(u, u).toMatch(/^[a-z-]+\/[a-z-]+@[0-9a-f]{40}$/);
    // Every checkout of specreview names this workflow's repository and commit.
    const tool = lines.flatMap((l, i) => (/^ {10}path: specreview-tool$/.test(l) ? [i] : []));
    expect(tool).toHaveLength(2);
    for (const at of tool) {
      const step = lines.slice(at - 4, at);
      expect(step).toEqual([
        expect.stringMatching(/uses: actions\/checkout@/),
        '        with:',
        '          repository: ${{ job.workflow_repository }}',
        '          ref: ${{ job.workflow_sha }}',
      ]);
    }
    expect(text).not.toMatch(/jadedm\/specreview\/(build|publish)@/);
  });

  it('W2: the product repo and the tool are checked out side by side; the build runs in the product repo', () => {
    const build = job('build');
    const paths = build.flatMap((l) => /^ {10}path: (\S+)$/.exec(l)?.[1] ?? []);
    expect(paths).toEqual(['product', 'specreview-tool', 'product', 'product/.specreview']);
    const at = build.indexOf('      - uses: ./specreview-tool/build');
    expect(build[at + 2]).toBe('          path: product');
  });

  it("W2: each job first stops when the workflow's own commit is not a full commit", () => {
    for (const name of ['build', 'publish']) {
      const steps = job(name);
      const first = steps.findIndex((l) => l.startsWith('      - '));
      expect(steps[first], name).toBe("      - name: Check this workflow's own commit");
      const check = steps
        .slice(
          first,
          steps.findIndex((l, i) => i > first && l.startsWith('      - ')),
        )
        .join('\n');
      expect(check, name).toContain('[[ "$WORKFLOW_SHA" =~ ^[0-9a-f]{40}$ && -n "$WORKFLOW_REPOSITORY" ]]');
      expect(check, name).toMatch(/\|\| \{ echo "[^"]+"; exit 1; \}/);
    }
  });

  it('W5, 185: the second step of each job installs libatomic on dnf machines, before any action runs', () => {
    for (const name of ['build', 'publish']) {
      const steps = job(name);
      const starts = steps.flatMap((l, i) => (l.startsWith('      - ') ? [i] : []));
      expect(steps[starts[1]], name).toBe('      - name: Install libatomic where dnf has it missing');
      expect(steps.slice(starts[1] + 1, starts[2]), name).toEqual(LIBATOMIC);
      // Every uses: (checkout, the actions, setup-node within them) comes after.
      expect(steps.slice(0, starts[2]).join('\n'), name).not.toContain('uses:');
    }
  });

  describe.each(['build', 'publish'])("W6, 185: the %s job's libatomic step run under bash", (name) => {
    let dir: string;
    // The step's script as the file holds it: the lines after its `run: |`.
    const steps = job(name);
    const at = steps.indexOf('      - name: Install libatomic where dnf has it missing');
    const end = steps.findIndex((l, i) => i > at && l.startsWith('      - '));
    const body = steps.slice(at + 1, end);
    const script = body
      .slice(body.indexOf('        run: |') + 1)
      .map((l) => l.slice(10))
      .join('\n');
    // Stand-ins on an otherwise empty PATH, each recording how it was called.
    const run = (stubs: Record<string, number>) => {
      dir = mkdtempSync(path.join(tmpdir(), 'libatomic-'));
      const log = path.join(dir, 'calls');
      writeFileSync(log, '');
      for (const [name, code] of Object.entries(stubs)) {
        const file = path.join(dir, name);
        writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> "${log}"\nexit ${code}\n`);
        chmodSync(file, 0o755);
      }
      writeFileSync(path.join(dir, 'step.sh'), `${script}\n`);
      let status = 0;
      try {
        execFileSync('/bin/bash', ['--noprofile', '--norc', '-eo', 'pipefail', path.join(dir, 'step.sh')], {
          env: { PATH: dir },
          stdio: 'pipe',
        });
      } catch (e) {
        status = (e as { status: number }).status;
      }
      return { status, calls: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) };
    };
    const cleanup = () => rmSync(dir, { recursive: true, force: true });

    it('without dnf it does nothing and succeeds', () => {
      expect(run({ rpm: 1, sudo: 0 })).toEqual({ status: 0, calls: [] });
      cleanup();
    });
    it('with dnf and libatomic installed it installs nothing', () => {
      expect(run({ dnf: 0, rpm: 0, sudo: 0 })).toEqual({ status: 0, calls: ['rpm -q libatomic'] });
      cleanup();
    });
    it('with dnf and libatomic missing it installs it, without asking for a password', () => {
      expect(run({ dnf: 0, rpm: 1, sudo: 0 })).toEqual({
        status: 0,
        calls: ['rpm -q libatomic', 'sudo -n dnf install -y -q libatomic'],
      });
      cleanup();
    });
    it('a failing install fails the step', () => {
      expect(run({ dnf: 0, rpm: 1, sudo: 1 }).status).toBe(1);
      cleanup();
    });
  });

  it('W3: the build job reads only; the publish job alone asks for a token, on pushes, after the build', () => {
    const build = job('build');
    const perms = (steps: string[]) => {
      const at = steps.indexOf('    permissions:');
      const end = steps.findIndex((l, i) => i > at && /^ {4}\S/.test(l));
      return steps.slice(at + 1, end);
    };
    expect(perms(build)).toEqual(['      contents: read']);
    expect(build.join('\n')).not.toContain('id-token');
    const publish = job('publish');
    expect(perms(publish)).toEqual(['      contents: read', '      id-token: write']);
    expect(publish).toContain("    if: github.event_name == 'push'");
    expect(publish).toContain('    needs: build');
    // The build is kept for the publish job on pushes only.
    const upload = build.findIndex((l) => l.includes('actions/upload-artifact@'));
    expect(build.slice(upload - 2, upload)).toEqual(["      - if: github.event_name == 'push'", '        id: upload']);
  });

  it("W3: the publish job downloads the build job's own build by id, and stops without one", () => {
    expect(job('build')).toContain('      artifact-id: ${{ steps.upload.outputs.artifact-id }}');
    const publish = job('publish');
    expect(publish).toContain('          artifact-ids: ${{ needs.build.outputs.artifact-id }}');
    expect(publish.join('\n')).not.toMatch(/^ {10}name: /m);
    expect(publish).toContain(
      '          [[ "$ARTIFACT_ID" =~ ^[0-9]+$ ]] || { echo "the build job named no build, so nothing is published"; exit 1; }',
    );
  });
});
