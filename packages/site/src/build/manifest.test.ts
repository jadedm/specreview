import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_MANIFEST_BYTES } from '@specreview/shared';
import { checkGit } from './checks.js';
import {
  assertManifestSize,
  cspFor,
  docBodyOf,
  inlineScriptHashes,
  parseGitLog,
  parseIssues,
  sectionsOf,
  textOf,
} from './manifest.js';

describe('front matter tickets', () => {
  it('accepts distinct positive ticket numbers and nothing else', () => {
    expect(parseIssues('a.md', undefined)).toEqual([]);
    expect(parseIssues('a.md', [52, 23])).toEqual([52, 23]);
    for (const bad of [[52, 52], [0], [-1], [1.5], ['52'], '52', null]) {
      expect(() => parseIssues('a.md', bad), JSON.stringify(bad)).toThrow('distinct ticket numbers');
    }
  });
});

describe('section text', () => {
  const html = `<html><main><div style="x" class="vp-doc _p" data-v-1><div>
    <h1 id="t">Title</h1><p>Intro <code>ariai</code>: text.</p>
    <h2 id="one" tabindex="-1">One <a class="header-anchor" href="#one">&#8203;</a></h2>
    <ul><li>first item.</li><li>second &amp; <strong>bold</strong></li></ul>
    <h3 id="two">Two</h3><p>a&nbsp;b &lt;tag&gt;</p>
  </div></div><footer><div>not body</div></footer></main></html>`;

  it('takes the vp-doc element only, balancing nested divs', () => {
    const body = docBodyOf(html);
    expect(body).toContain('second');
    expect(body).not.toContain('not body');
  });

  it('splits at h2 and h3, keeps text before the first as the top, separates blocks', () => {
    expect(sectionsOf(docBodyOf(html))).toEqual([
      { id: '_top', title: '', text: 'Intro ariai: text.' },
      { id: 'one', title: 'One', text: 'first item. second & bold' },
      { id: 'two', title: 'Two', text: 'a b <tag>' },
    ]);
  });

  it('decodes numeric entities and drops zero-width spaces', () => {
    expect(textOf('a&#x41;&#66;&#8203;c')).toBe('aABc');
  });
});

describe('git history', () => {
  it('follows renames and reads the PR from a squash subject', () => {
    const log = [
      '\x1eaaa\x1f2026-10-07T10:00:00+05:30\x1fManish Jadhav\x1fdocs(docs): roster only (#58)\n\nM\tdocs/content/onboarding/roster.md\n',
      '\x1ebbb\x1f2026-10-05T10:00:00+05:30\x1fManish Jadhav\x1fdocs: move page\n\nR100\tdocs/content/old.md\tdocs/content/onboarding/roster.md\n',
      '\x1eccc\x1f2026-10-03T10:00:00+05:30\x1fShubham\x1fdocs: first draft (#51)\n\nA\tdocs/content/old.md\n',
    ].join('');
    const got = parseGitLog(log, 'docs/content/').map(({ commit, pr, path, repoPath }) => ({
      commit,
      pr,
      path,
      repoPath,
    }));
    expect(got).toEqual([
      { commit: 'aaa', pr: 58, path: 'onboarding/roster.md', repoPath: 'docs/content/onboarding/roster.md' },
      { commit: 'bbb', pr: null, path: 'onboarding/roster.md', repoPath: 'docs/content/onboarding/roster.md' },
      { commit: 'ccc', pr: 51, path: 'old.md', repoPath: 'docs/content/old.md' },
    ]);
  });

  it('a page moved in from outside the content folder publishes only its versions inside it', () => {
    const log = [
      '\x1eaaa\x1f2026-10-07\x1fM\x1fdocs: move (#60)\n\nR090\tnotes/roster.md\tdocs/content/roster.md\n',
      '\x1ebbb\x1f2026-10-05\x1fM\x1fnotes\n\nA\tnotes/roster.md\n',
      '\x1eccc\x1f2026-10-04\x1fM\x1fMerge branch x\n',
      '\x1eddd\x1f2026-10-03\x1fM\x1fcopy\n\nC075\tdocs/content/a.md\tdocs/content/roster.md\n',
    ].join('');
    const got = parseGitLog(log, 'docs/content/').map(({ commit, path, repoPath }) => [commit, path, repoPath]);
    expect(got).toEqual([
      ['aaa', 'roster.md', 'docs/content/roster.md'],
      ['ddd', 'roster.md', 'docs/content/roster.md'],
    ]);
  });
});

describe('23: manifest size', () => {
  it('takes a manifest up to the limit and refuses one byte more', () => {
    expect(() => assertManifestSize('x'.repeat(MAX_MANIFEST_BYTES))).not.toThrow();
    expect(() => assertManifestSize('x'.repeat(MAX_MANIFEST_BYTES + 1))).toThrow(/at most/);
    // Bytes, not characters: four bytes each.
    expect(() => assertManifestSize('\u{1f600}'.repeat(MAX_MANIFEST_BYTES / 4 + 1))).toThrow(/at most/);
  });
});

describe('CSP', () => {
  it('hashes inline scripts only, and lists each once', () => {
    const html =
      '<script>a()</script><script src="/x.js"></script><script type="module">a()</script><script> </script>';
    const hashes = inlineScriptHashes(html);
    expect(hashes).toHaveLength(2);
    expect(hashes[0]).toMatch(/^'sha256-[A-Za-z0-9+/]+=*'$/);
    const csp = cspFor(hashes);
    expect(csp.match(/sha256-/g)).toHaveLength(1);
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
  });
});

describe('24: history needs a full clone', () => {
  it('a full repo passes; a shallow clone of it is refused', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'docs-history-'));
    const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
    try {
      const full = path.join(dir, 'full');
      run(dir, 'init', '-q', full);
      for (const n of [1, 2]) {
        writeFileSync(path.join(full, 'page.md'), `v${n}`);
        run(full, 'add', 'page.md');
        run(full, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', `v${n}`);
      }
      expect(() => checkGit(full)).not.toThrow();
      run(dir, 'clone', '-q', '--depth', '1', `file://${full}`, 'shallow');
      expect(() => checkGit(path.join(dir, 'shallow'))).toThrow('full git history');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000); // eight git subprocesses; slow when the Worker project runs alongside
});
