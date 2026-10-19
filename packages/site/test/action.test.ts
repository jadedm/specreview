// #88: the build action's step turns the exclude input into --exclude
// arguments, one per non-empty line, never word-split or evaluated.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const action = readFileSync(path.join(import.meta.dirname, '../../../build/action.yml'), 'utf8');
// The "Build the site" step's run block, as the runner gives it to bash.
const script = (() => {
  const step = action.slice(action.indexOf('- name: Build the site'));
  const run = step.slice(step.indexOf('run: |') + 'run: |'.length);
  return run
    .split('\n')
    .slice(1)
    .filter((l) => l.startsWith('        '))
    .map((l) => l.slice(8))
    .join('\n');
})();

const argsFor = (exclude: string, prototypes = '') => {
  const dir = mkdtempSync(path.join(tmpdir(), 'action-'));
  const actionPath = path.join(dir, 'build');
  mkdirSync(path.join(dir, 'packages/site/dist/build'), { recursive: true });
  mkdirSync(actionPath);
  // A stand-in for the build: prints the arguments it got.
  writeFileSync(
    path.join(dir, 'packages/site/dist/build/cli.js'),
    'console.log(JSON.stringify(process.argv.slice(2)))',
  );
  const r = spawnSync('bash', ['-eo', 'pipefail', '-c', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_ACTION_PATH: actionPath,
      INPUT_REPO: 'r',
      INPUT_DOCS: 'docs',
      INPUT_OUT: '.specreview',
      INPUT_EXCLUDE: exclude,
      INPUT_PROTOTYPES: prototypes,
    },
  });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as string[];
};

describe('#88: the build action passes excludes through as they are', () => {
  it('none, one per line, blank lines skipped, no trailing newline needed', () => {
    expect(argsFor('')).toEqual(['build', '--repo', 'r', '--docs', 'docs', '--out', '.specreview']);
    expect(argsFor('product/prototypes\n\ndrafts/\n').slice(7)).toEqual([
      '--exclude',
      'product/prototypes',
      '--exclude',
      'drafts/',
    ]);
    expect(argsFor('a\nb').slice(7)).toEqual(['--exclude', 'a', '--exclude', 'b']);
  });

  it('spaces, quotes, $(...) and ; reach the build as one literal argument each, for it to refuse', () => {
    const lines = ['a b', '$(touch /tmp/owned)', 'x; echo hi', `it's "q"`, '*'];
    expect(argsFor(lines.join('\n')).slice(7)).toEqual(lines.flatMap((l) => ['--exclude', l]));
  });
});

describe('#111: the build action passes prototype folders through the same way', () => {
  it('one --prototypes per non-empty line, after the excludes, never word-split', () => {
    expect(argsFor('drafts', 'product/prototypes\n\nother proto/x\n').slice(7)).toEqual([
      '--exclude',
      'drafts',
      '--prototypes',
      'product/prototypes',
      '--prototypes',
      'other proto/x',
    ]);
    expect(argsFor('', '').length).toBe(7);
  });
});
