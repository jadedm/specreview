import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkArguments, checkPaths, forbiddenIn, OUTPUT_MARK } from './checks.js';

describe('20: Markdown features that pull in files or run code', () => {
  it.each([
    ['<<< @/snippets/a.js', 'snippet imports'],
    ['<script setup>', 'script blocks'],
    ['<SCRIPT>alert(1)</SCRIPT>', 'script blocks'],
    ['<style scoped>', 'style blocks'],
  ])('%s is refused outside code', (line, kind) => {
    expect(forbiddenIn(`# Page\n\n${line}\n`)).toContain(kind);
  });

  it('includes are refused anywhere, code included: they are expanded before Markdown', () => {
    for (const page of [
      '<!--@include: ./other.md-->',
      '`<!--@include: ../secret.md-->`',
      '```\n<!-- @include: ../secret.md -->\n```',
    ]) {
      expect(forbiddenIn(`# Page\n\n${page}\n`), page).toContain('includes');
    }
  });

  it('script, style and snippets inside fenced or inline code are fine; braces are not checked here', () => {
    const page = [
      '# Page',
      '```vue',
      '<script setup>',
      '```',
      '~~~',
      '<<< @/x.js',
      '~~~',
      'Write `<script>` to see it, or {{ name }}.',
    ].join('\n');
    expect(forbiddenIn(page)).toBeNull();
  });

  it('a fence closes only with its own character, at least as long', () => {
    expect(forbiddenIn('````\n```\n<script>\n```\n````\n')).toBeNull();
    expect(forbiddenIn('```\n~~~\n<script>\n```\n')).toBeNull();
    expect(forbiddenIn('```\ncode\n```\n<script>\n')).toContain('script blocks');
  });
});

describe('21: names the hub can serve', () => {
  it('accepts plain names, dots inside names, folders and plain public files', () => {
    expect(() =>
      checkPaths([
        'index.md',
        'release-1.2.md',
        'notes.v2/index.md',
        'a_b/c~d.md',
        'img/x.png',
        'public/logo.png',
        'public/a/b.pdf',
      ]),
    ).not.toThrow();
  });

  it.each([
    ['my page.md'],
    ['100%.md'],
    ['_api/x.md'],
    ['_history/x.md'],
    ['ümlaut.md'],
    ['a/b c/d.md'],
    ['.env'],
    ['guide/.hidden.md'],
    ['public/.well/x.txt'],
    ['public/_api/help.txt'],
    ['public/x.html'],
    ['public/app.js'],
    ['public/logo.svg'],
    ['public/manifest.json'],
  ])('%s is refused, naming the file', (file) => {
    expect(() => checkPaths(['index.md', file])).toThrow(file);
  });

  it('_api deeper in the tree is an ordinary folder name', () => {
    expect(() => checkPaths(['guide/_api/x.md'])).not.toThrow();
  });
});

describe('24: arguments', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'site-args-'));
    mkdirSync(path.join(root, 'docs'));
    mkdirSync(path.join(root, '.git'));
    writeFileSync(path.join(root, 'docs', 'index.md'), '# Home\n');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const paths = (docs = 'docs', out = '.specreview') => ({
    root,
    docs: path.join(root, docs),
    out: path.resolve(root, out),
  });

  it('a lowercase repo name, docs inside the repo and a fresh out folder are fine', () => {
    expect(() => checkArguments('sidecar', paths())).not.toThrow();
  });

  it.each([['Sidecar'], ['inoltrotech/sidecar'], ['..'], [''], ['a b']])('repo %j is refused', (repo) => {
    expect(() => checkArguments(repo, paths())).toThrow('--repo');
  });

  it('docs outside the repo or missing', () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'site-outside-'));
    try {
      expect(() => checkArguments('x', { ...paths(), docs: outside })).toThrow('inside the repository');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
    expect(() => checkArguments('x', paths('nope'))).toThrow('is not a folder');
  });

  it.each([['.'], ['..'], ['.git'], ['.git/objects'], ['docs'], ['docs/.out'], ['/tmp']])(
    'out %j, which the build would empty, is refused',
    (out) => {
      expect(() => checkArguments('x', paths('docs', out))).toThrow('--out');
    },
  );

  it('an out folder with other files is refused unless it is an earlier build output', () => {
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src', 'main.ts'), 'x');
    expect(() => checkArguments('x', paths('docs', 'src'))).toThrow('not an earlier build');
    writeFileSync(path.join(root, 'src', OUTPUT_MARK), '');
    expect(() => checkArguments('x', paths('docs', 'src'))).not.toThrow();
  });
});
