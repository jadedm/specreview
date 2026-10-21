import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_MANIFEST_BYTES } from '@specreview/shared';
import { checkGit } from './checks.js';
import {
  assertManifestSize,
  isKnownScript,
  cspFor,
  docBodyOf,
  inlineScriptHashes,
  parseCommitDetails,
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

  it('#90 (5, 6): takes <repo>#<number> for another ticket repo, in the repo name grammar', () => {
    expect(parseIssues('a.md', [3, 'backend#4', 'web.app_2-x#10'])).toEqual([3, 'backend#4', 'web.app_2-x#10']);
    for (const bad of [
      ['Backend#4'],
      ['backend#0'],
      ['backend#04'],
      ['#4'],
      ['a/b#4'],
      ['backend#4', 'backend#4'],
      ['backend #4'],
      ['backend#4.5'],
      ['..#4'],
      [`backend#${'9'.repeat(17)}`],
    ]) {
      expect(() => parseIssues('a.md', bad), JSON.stringify(bad)).toThrow('<repo>#<number>');
    }
  });
});

describe('section text', () => {
  const html = `<html><main><div style="x" class="vp-doc _p" data-v-1><div>
    <h1 id="t">Title</h1><p>Intro <code>initech</code>: text.</p>
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
      { id: '_top', title: '', text: 'Intro initech: text.' },
      { id: 'one', title: 'One', text: 'first item. second & bold' },
      { id: 'two', title: 'Two', text: 'a b <tag>' },
    ]);
  });

  it('decodes numeric entities and drops zero-width spaces', () => {
    expect(textOf('a&#x41;&#66;&#8203;c')).toBe('aABc');
  });
});

describe('git history', () => {
  // As `git log --follow --name-status -z --format=%H` writes it: the id, a
  // newline before the first status, every field ended by NUL.
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  const C = 'c'.repeat(40);
  const D = 'd'.repeat(40);
  const record = (commit: string, ...changes: string[][]) =>
    `${commit}\0${changes.map((c, i) => `${i === 0 ? '\n' : ''}${c.join('\0')}\0`).join('')}`;

  it('follows renames; only versions inside the content folder are kept', () => {
    const log = [
      record(A, ['M', 'docs/content/onboarding/roster.md']),
      record(B, ['R100', 'docs/content/old.md', 'docs/content/onboarding/roster.md']),
      record(C, ['A', 'docs/content/old.md']),
    ].join('');
    expect(parseGitLog(log, 'docs/content/')).toEqual([
      { commit: A, path: 'onboarding/roster.md', repoPath: 'docs/content/onboarding/roster.md' },
      { commit: B, path: 'onboarding/roster.md', repoPath: 'docs/content/onboarding/roster.md' },
      { commit: C, path: 'old.md', repoPath: 'docs/content/old.md' },
    ]);
  });

  it('a page moved in from outside the content folder publishes only its versions inside it', () => {
    const log = [
      record(A, ['R090', 'notes/roster.md', 'docs/content/roster.md']),
      record(B, ['A', 'notes/roster.md']),
      record(C),
      record(D, ['C075', 'docs/content/a.md', 'docs/content/roster.md']),
    ].join('');
    expect(parseGitLog(log, 'docs/content/').map((e) => e.commit)).toEqual([A, D]);
  });

  it('a deletion or a type change is not a version; a path may hold a tab or a newline', () => {
    const log = [
      record(A, ['A', 'docs/x\ty.md']),
      record(B, ['D', 'docs/x\ty.md']),
      record(C, ['T', 'docs/x\ty.md']),
      record(D, ['A', 'docs/x\ny.md']),
    ].join('');
    expect(parseGitLog(log, 'docs/')).toEqual([
      { commit: A, path: 'x\ty.md', repoPath: 'docs/x\ty.md' },
      { commit: D, path: 'x\ny.md', repoPath: 'docs/x\ny.md' },
    ]);
    expect(parseGitLog('', 'docs/')).toEqual([]);
  });

  it('only a 40-character lowercase hex commit id is read as one; anything else stops the build', () => {
    for (const commit of ['a'.repeat(39), 'A'.repeat(40), `${'a'.repeat(40)}x`, `HEAD^{/x}`, '../../x', ''])
      expect(() => parseGitLog(record(commit, ['M', 'docs/a.md']), 'docs/'), commit).toThrow(/expected a commit id/);
  });

  it('a field out of place, a missing path or a missing final NUL stops the build', () => {
    expect(() => parseGitLog(record(A, ['Q', 'docs/a.md']), 'docs/')).toThrow(/expected a change status/);
    expect(() => parseGitLog(`${A}\0\nR100\0docs/a.md\0`, 'docs/')).toThrow(/expected a path/);
    expect(() => parseGitLog(`${A}\0\nM\0\0`, 'docs/')).toThrow(/expected a path/);
    expect(() => parseGitLog(`${A}\0\nM\0docs/a.md`, 'docs/')).toThrow(/NUL at the end/);
    // A subject never reaches this stream, but one shaped like records is refused if it did.
    expect(() => parseGitLog(`${A}\0x\x1e${B}\x1f2026\0\nM\0docs/a.md\0`, 'docs/')).toThrow(/expected a change status/);
  });

  it("a commit's details: three fields, an ISO date, the PR from a squash subject", () => {
    expect(parseCommitDetails('2026-10-07T10:00:00+05:30\0Manish Jadhav\0docs: roster only (#58)\n')).toEqual({
      date: '2026-10-07T10:00:00+05:30',
      author: 'Manish Jadhav',
      pr: 58,
    });
    expect(parseCommitDetails('2026-10-07T10:00:00Z\0M\0edit\x1ex\x1f../y (#12)\n')).toEqual({
      date: '2026-10-07T10:00:00Z',
      author: 'M',
      pr: 12,
    });
    expect(parseCommitDetails('2026-10-07T10:00:00Z\0M\0no number\n').pr).toBeNull();
    for (const bad of ['2026-10-07T10:00:00Z\0M\n', '2026-10-07T10:00:00Z\0M\0s\0t\n', 'yesterday\0M\0s\n'])
      expect(() => parseCommitDetails(bad), JSON.stringify(bad)).toThrow(/git log/);
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

describe('only the inline scripts VitePress writes', () => {
  const MAC = 'document.documentElement.classList.toggle("mac",/Mac|iPhone|iPod|iPad/i.test(navigator.platform));';
  const DATA =
    'window.__VP_HASH_MAP__=JSON.parse("{\\"index.md\\":\\"abc\\"}");window.__VP_SITE_DATA__=JSON.parse("{\\"title\\":\\"T\\"}");';
  it('accepts the macOS check and the data script', () => {
    expect(isKnownScript('id="check-mac-os"', MAC)).toBe(true);
    expect(isKnownScript('', DATA)).toBe(true);
  });

  it.each([
    ['a page script', '', 'window.__PWN=1'],
    ['the macOS check under another id', 'id="other"', MAC],
    ['code after the data', '', `${DATA}alert(1);`],
    ['code between the data', '', DATA.replace(';window.__VP_SITE_DATA__', ';alert(1);window.__VP_SITE_DATA__')],
    [
      'a string that does not close',
      '',
      'window.__VP_HASH_MAP__=JSON.parse("x);window.__VP_SITE_DATA__=JSON.parse("y");',
    ],
  ])('refuses %s', (_name, attrs, code) => {
    expect(isKnownScript(attrs, code)).toBe(false);
  });
});
