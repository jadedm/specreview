// The reusable workflow product repos call (#177), read as text: its inputs,
// what each job may do, and that the build and publish actions run from the
// workflow's own commit. Cases are the ticket's W rows.
import { readFileSync } from 'node:fs';
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

describe('177: the reusable publish workflow', () => {
  it('W1: it is only called, with exactly the five inputs', () => {
    const on = blockAfter(/^on:$/);
    expect(on.filter((l) => /^ {2}\S/.test(l))).toEqual(['  workflow_call:']);
    const inputs = blockAfter(/^ {4}inputs:$/).flatMap((l) => /^ {6}([a-z]+):$/.exec(l)?.[1] ?? []);
    expect(inputs).toEqual(['hub', 'repo', 'docs', 'exclude', 'prototypes']);
    expect(text).not.toMatch(/secrets:/);
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
