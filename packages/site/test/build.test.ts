// The built command against real git repos: what a product repo's CI runs.
// The package is built before these tests (package.json "test").
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isContentAddressed, isManifest, type Manifest } from '@specreview/shared';
import { MERMAID_VERSION } from '../src/build/mermaid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CLI = path.join(import.meta.dirname, '..', 'dist', 'build', 'cli.js');
const scratch = mkdtempSync(path.join(tmpdir(), 'site-build-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=Tester', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim();

let n = 0;
const newRepo = () => {
  const dir = path.join(scratch, `repo${++n}`);
  mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  return dir;
};
const write = (repo: string, file: string, text: string) => {
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  writeFileSync(path.join(repo, file), text);
};
const commit = (repo: string, message: string) => {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
};
const build = (repo: string, ...args: string[]) => {
  const r = spawnSync('node', [CLI, 'build', '--repo', 'fixture', ...args], { cwd: repo, encoding: 'utf8' });
  // VitePress colours its log on GitHub Actions (escape codes inside "dead link ./x"); matched as plain text.
  return { status: r.status, stderr: r.stderr.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '') };
};
const manifestOf = (repo: string, out = '.specreview') =>
  JSON.parse(readFileSync(path.join(repo, out, 'site', 'manifest.json'), 'utf8')) as Manifest;
const filesUnder = (dir: string) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => path.relative(dir, path.join(d.parentPath, d.name)).split(path.sep).join('/'))
    .sort();
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

const page = (title: string, body: string, front = '') => `---\n${front}---\n\n# ${title}\n\n${body}\n`;

// The main fixture: three commits, a folder, a rename across folders, a page
// moved in from outside docs, dotted names, a folder index beside a page of
// the same name, raw HTML, code with braces, and a repeated heading.
describe('a full build', () => {
  let repo: string;
  let head: string;
  let firstSignup: string;
  beforeAll(() => {
    repo = newRepo();
    write(
      repo,
      'docs/index.md',
      page('Fixture docs', 'Welcome.\n\n## How review works\n\nPages are reviewed.', 'title: Fixture docs\n'),
    );
    write(
      repo,
      'docs/onboarding/signup.md',
      page('Company signup', '## Limits\n\nThree companies per account.', 'issues: [52, 23]\n'),
    );
    write(repo, 'docs/old/moving.md', page('Moving page', 'Before the move.'));
    write(repo, 'notes/outside.md', page('Outside', 'Private notes outside docs.'));
    firstSignup = readFileSync(path.join(repo, 'docs/onboarding/signup.md'), 'utf8');
    commit(repo, 'docs: first draft (#1)');
    write(
      repo,
      'docs/onboarding/signup.md',
      page('Company signup', '## Limits\n\nFour companies per account.', 'issues: [52, 23]\n'),
    );
    mkdirSync(path.join(repo, 'docs/new'));
    git(repo, 'mv', 'docs/old/moving.md', 'docs/new/moving.md');
    git(repo, 'mv', 'notes/outside.md', 'docs/outside.md');
    commit(repo, 'docs: move pages (#2)');
    write(repo, 'docs/guide.md', page('Guide page', 'The page called guide.'));
    write(repo, 'docs/guide/index.md', page('Guide', 'The guide folder.'));
    write(repo, 'docs/release-1.2.md', page('Release 1.2', 'Dotted name.'));
    write(repo, 'docs/notes.v2/index.md', page('Notes v2', 'Dotted folder.'));
    write(repo, 'docs/raw.md', page('Raw', '<div class="injected">raw html</div>\n\n```js\nconst a = { b: 1 };\n```'));
    write(repo, 'docs/repeat.md', page('Repeat', '## Notes\n\nfirst\n\n## Notes\n\nsecond'));
    head = commit(repo, 'docs: more pages (#3)');
    const r = build(repo);
    expect(r.stderr).toContain('built');
    expect(r.status).toBe(0);
  });

  it('1: writes the site and every version of every page', () => {
    const site = filesUnder(path.join(repo, '.specreview', 'site'));
    for (const f of [
      'index.html',
      'onboarding/signup.html',
      'guide.html',
      'guide/index.html',
      'release-1.2.html',
      'notes.v2/index.html',
      '404.html',
      'manifest.json',
    ]) {
      expect(site, f).toContain(f);
    }
    const history = filesUnder(path.join(repo, '.specreview', 'history'));
    expect(history.filter((f) => f.endsWith('/onboarding/signup.md'))).toHaveLength(2);
    // The older version is the text as it was.
    const [first] = git(repo, 'rev-list', '--max-parents=0', 'HEAD').split('\n');
    expect(readFileSync(path.join(repo, '.specreview', 'history', first, 'onboarding/signup.md'), 'utf8')).toBe(
      firstSignup,
    );
  });

  it('#52: the 404 page says what happened in plain words and links back to the site', () => {
    const html = readFileSync(path.join(repo, '.specreview', 'site', '404.html'), 'utf8');
    expect(html).toContain('Page not found');
    expect(html).not.toContain('PAGE NOT FOUND');
    expect(html).toMatch(/This page doesn(&#39;|')t exist\. It may have been moved or renamed\./);
    expect(html).toContain('Go to Fixture docs');
    // The link's label travels in the embedded site data, applied in the browser.
    expect(html).toMatch(/linkLabel\\?":\\?"Go to Fixture docs/);
    expect(html).not.toContain('Take me home');
  });

  it('2: every internal link and asset is under the base', () => {
    const site = path.join(repo, '.specreview', 'site');
    for (const f of filesUnder(site).filter((x) => x.endsWith('.html'))) {
      const html = readFileSync(path.join(site, f), 'utf8');
      const refs = [...html.matchAll(/\b(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
      for (const ref of refs.filter((r) => r.startsWith('/'))) expect(ref, `${f}: ${ref}`).toMatch(/^\/fixture\//);
    }
  });

  it('3: the manifest is one the hub accepts, naming HEAD, with source hashes, tickets and history', () => {
    const m = manifestOf(repo);
    expect(isManifest(m)).toBe(true);
    expect(m.commit).toBe(head);
    const source = readFileSync(path.join(repo, 'docs/onboarding/signup.md'), 'utf8');
    expect(m.pages['onboarding/signup']).toMatchObject({
      title: 'Company signup',
      hash: sha(source),
      issues: [52, 23],
    });
    expect(m.pages['onboarding/signup'].history.map((h) => h.pr)).toEqual([2, 1]);
    expect(Object.keys(m.pages).sort()).toEqual([
      'guide',
      'guide/index',
      'index',
      'new/moving',
      'notes.v2/index',
      'onboarding/signup',
      'outside',
      'raw',
      'release-1.2',
      'repeat',
    ]);
  });

  it('16: a rename across folders is followed; versions outside docs are not published', () => {
    const m = manifestOf(repo);
    expect(m.pages['new/moving'].history.map((h) => h.path)).toEqual(['new/moving.md', 'old/moving.md']);
    expect(m.pages.outside.history.map((h) => h.path)).toEqual(['outside.md']);
    const history = filesUnder(path.join(repo, '.specreview', 'history'));
    expect(history.some((f) => f.includes('notes/'))).toBe(false);
  });

  it('4: the CSP lists a hash for every inline script in every page', () => {
    const m = manifestOf(repo);
    const site = path.join(repo, '.specreview', 'site');
    for (const f of filesUnder(site).filter((x) => x.endsWith('.html'))) {
      const html = readFileSync(path.join(site, f), 'utf8');
      for (const [, code] of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
        if (code.trim() === '') continue;
        const hash = createHash('sha256').update(code).digest('base64');
        expect(m.csp, `${f}`).toContain(`'sha256-${hash}'`);
      }
    }
    expect(m.csp).toMatch(/^[\x20-\x7e]+$/);
    expect(m.csp).not.toMatch(/script-src[^;]*unsafe-inline/);
  });

  it('5: raw HTML is shown as text, not markup', () => {
    const html = readFileSync(path.join(repo, '.specreview', 'site', 'raw.html'), 'utf8');
    expect(html).not.toContain('<div class="injected">');
    expect(html).toContain('&lt;div class=&quot;injected&quot;&gt;');
  });

  it('8: a repeated heading gets its own id, and the manifest has the same ids as the page', () => {
    const m = manifestOf(repo);
    const html = readFileSync(path.join(repo, '.specreview', 'site', 'repeat.html'), 'utf8');
    const ids = [...html.matchAll(/<h[23] id="([^"]+)"/g)].map((x) => x[1]);
    expect(ids).toEqual(['notes', 'notes-1']);
    expect(m.pages.repeat.sections.map((s) => s.id)).toEqual(ids);
  });

  it('22: folder indexes and dotted names get the keys the hub and UI use', () => {
    const m = manifestOf(repo);
    expect(m.pages['guide/index'].title).toBe('Guide');
    expect(m.pages.guide.title).toBe('Guide page');
    expect(m.pages['release-1.2'].title).toBe('Release 1.2');
    expect(m.pages['notes.v2/index'].title).toBe('Notes v2');
  });

  it('7, 17: a rebuild of the same commit gives the same output; a deleted page leaves nothing behind', () => {
    const before = { ...manifestOf(repo), builtAt: '' };
    const files = filesUnder(path.join(repo, '.specreview'));
    expect(build(repo).status).toBe(0);
    expect({ ...manifestOf(repo), builtAt: '' }).toEqual(before);
    expect(filesUnder(path.join(repo, '.specreview'))).toEqual(files);
    git(repo, 'rm', '-q', 'docs/raw.md');
    commit(repo, 'docs: drop raw (#4)');
    expect(build(repo).status).toBe(0);
    expect(manifestOf(repo).pages.raw).toBeUndefined();
    expect(existsSync(path.join(repo, '.specreview', 'site', 'raw.html'))).toBe(false);
    expect(filesUnder(path.join(repo, '.specreview', 'history')).some((f) => f.endsWith('/raw.md'))).toBe(false);
  });
});

describe('builds that must fail, naming the cause', () => {
  const minimal = () => {
    const repo = newRepo();
    write(repo, 'docs/index.md', page('Home', 'Text.'));
    commit(repo, 'docs: home');
    return repo;
  };

  it('5: no index.md; bad issues', () => {
    const repo = newRepo();
    write(repo, 'docs/a.md', page('A', 'x'));
    commit(repo, 'a');
    expect(build(repo)).toMatchObject({
      status: 1,
      stderr: expect.stringContaining('index.md or README.md is required'),
    });
    for (const issues of ['"52"', '[52, 52]', '[0]']) {
      const r = minimal();
      write(r, 'docs/a.md', page('A', 'x', `issues: ${issues}\n`));
      commit(r, 'a');
      expect(build(r), issues).toMatchObject({ status: 1, stderr: expect.stringContaining('a.md') });
    }
  });

  it('#132 3: an error while rendering a page on the server fails the build, naming the page', () => {
    const repo = minimal();
    write(repo, 'docs/guide.md', page('Guide', 'Text.'));
    commit(repo, 'docs: guide');
    // The theme's test switch makes /fixture/guide throw while it renders.
    const r = spawnSync('node', [CLI, 'build', '--repo', 'fixture'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, SPECREVIEW_RENDER_ERROR_FOR_TESTS: '/fixture/guide' },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('while rendering /fixture/guide: a render error the build test asked for');
    // The failing component's own frames are kept.
    expect(r.stderr).toMatch(/while rendering \/fixture\/guide: [^\n]*\n\s+at setup/);
    expect(existsSync(path.join(repo, '.specreview', 'site'))).toBe(false);
    // The same repo builds without the switch.
    expect(build(repo)).toMatchObject({ status: 0 });
  });

  it('#79: a refused name in the log cannot start a workflow command', () => {
    const r = minimal();
    write(r, 'docs/x\n::error::y ##[warning]z.md', page('X', 'x'));
    commit(r, 'x');
    const out = build(r);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain(': :error: :y # #[warning]z.md');
    for (const line of out.stderr.split('\n')) expect(line.trimStart().startsWith('::'), line).toBe(false);
    expect(out.stderr).not.toContain('##[');
  });

  it('19: only what HEAD holds is published: no uncommitted, untracked or ignored file', () => {
    const repo = minimal();
    write(repo, '.gitignore', 'docs/ignored.md\ndocs/public/ign.txt\n');
    commit(repo, 'ignore');
    write(repo, 'docs/index.md', page('Home', 'Uncommitted edit.'));
    write(repo, 'docs/new.md', page('New', 'Not added.'));
    write(repo, 'docs/ignored.md', page('Ignored', 'Ignored by git.'));
    write(repo, 'docs/public/ign.txt', 'ignored asset');
    expect(build(repo).status).toBe(0);
    const m = manifestOf(repo);
    expect(Object.keys(m.pages)).toEqual(['index']);
    const site = filesUnder(path.join(repo, '.specreview', 'site'));
    expect(site.some((f) => /new|ignored|ign\.txt/.test(f))).toBe(false);
    const html = readFileSync(path.join(repo, '.specreview', 'site', 'index.html'), 'utf8');
    expect(html).not.toContain('Uncommitted edit');
    expect(m.pages.index.hash).toBe(sha(git(repo, 'show', 'HEAD:docs/index.md') + '\n'));
  });

  it('Vue interpolation never runs: text, inline code and escaped backticks show the braces', () => {
    const repo = minimal();
    write(
      repo,
      'docs/vue.md',
      page('Vue', 'Total {{ 6*7 }} here.\n\nCode `{{ 6*7 }}` here.\n\nPrice \\`{{ 6*7 }}\\` here.'),
    );
    commit(repo, 'vue');
    expect(build(repo).status).toBe(0);
    const html = readFileSync(path.join(repo, '.specreview', 'site', 'vue.html'), 'utf8');
    // What each line would become if Vue ran it. Not a bare '42': hashed ids
    // such as data-v-151942dc and asset names can contain it.
    expect(html).not.toMatch(/Total 42 here|>42<\/code>|`42`/);
    expect(html.match(/\{\{ 6\*7 \}\}|&#123;&#123; 6\*7 &#125;&#125;/g)?.length).toBe(3);
  });

  it('#73: a file of another type in the docs folder stops the build before anything runs or is written', () => {
    const repo = minimal();
    const marker = path.join(scratch, `ran-${n}`);
    write(
      repo,
      'docs/probe.js',
      `globalThis.process?.getBuiltinModule?.('node:fs')?.writeFileSync(${JSON.stringify(marker)}, '1');\nexport default 1;\n`,
    );
    write(repo, 'docs/probe.md', page('Probe', '![p](./probe.js)'));
    commit(repo, 'probe');
    const r = build(repo);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('probe.js: outside public/, the docs folder takes only .md pages and');
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(path.join(repo, '.specreview', 'site'))).toBe(false);
    expect(existsSync(path.join(repo, '.specreview', '.specreview-output'))).toBe(false);
  });

  it.each([
    ['data.csv', '![d](./data.csv)', 'data.csv: outside public/'],
    ['upper.MD', '![u](./upper.MD)', 'upper.MD: outside public/'],
    ['img.png', '![i](./img.png?worker)', 'img.png: a page may use this file only as a plain image or link'],
  ])('#73: %s used as %s is refused and nothing is published', (file, link, refusal) => {
    const repo = minimal();
    write(repo, `docs/${file}`, 'plain text\n');
    write(repo, 'docs/use.md', page('Use', link));
    commit(repo, 'use');
    const r = build(repo);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(refusal);
    expect(existsSync(path.join(repo, '.specreview', 'site'))).toBe(false);
  });

  it('a page may not use a file from outside the docs folder; one inside is fine', () => {
    const inside = minimal();
    write(inside, 'docs/img/dot.png', 'not really a png');
    write(inside, 'docs/pic.md', page('Pic', '![dot](./img/dot.png)'));
    commit(inside, 'pic');
    expect(build(inside).status).toBe(0);
    // Climbing past / and back down reaches any real file, whatever folder
    // the build runs in; only the confinement stops it.
    const secret = path.join(scratch, `secret-${n}.txt`);
    writeFileSync(secret, 'SECRET_ON_DISK=1');
    for (const target of ['../src/config.txt', `${'../'.repeat(30)}${secret.slice(1)}`]) {
      const repo = minimal();
      write(repo, 'src/config.txt', 'SECRET_IN_SRC=1');
      write(repo, 'docs/leak.md', page('Leak', `![a](${target})`));
      commit(repo, 'leak');
      const r = build(repo);
      expect(r.status, target).toBe(1);
      expect(existsSync(path.join(repo, '.specreview', 'site')), target).toBe(false);
    }
  });

  it('the confinement refuses a file under some other node_modules on the machine', () => {
    const secret = path.join(scratch, `outside-${n}`, 'node_modules', 'x', 'secret.txt');
    mkdirSync(path.dirname(secret), { recursive: true });
    writeFileSync(secret, 'SECRET_NM_TOKEN=abc');
    const repo = minimal();
    write(repo, 'docs/leak.md', page('Leak', `![a](${'../'.repeat(30)}${secret.slice(1)}?url)`));
    commit(repo, 'leak');
    expect(build(repo)).toMatchObject({
      status: 1,
      stderr: expect.stringContaining('only use files inside the docs folder'),
    });
  });

  it('a title, heading or folder starting _vp-fn_ is refused before VitePress could run it', () => {
    // No < or >, so this rule is what refuses it.
    const code = '_vp-fn_(function(){throw new Error("MARKER-"+(6*7))})()';
    const cases: [string, string, string][] = [
      ['front matter title', 'docs/fm.md', page('x', 'body', `title: '${code}'\n`)],
      ['heading', 'docs/h.md', `# ${code}\n\nbody\n`],
      ['folder name', 'docs/_vp-fn_1/p.md', page('P', 'body')],
    ];
    for (const [name, file, text] of cases) {
      const repo = minimal();
      write(repo, file, text);
      commit(repo, name);
      const r = build(repo);
      expect(r.status, name).toBe(1);
      expect(r.stderr, name).toContain('which VitePress would run as code');
      expect(r.stderr, name).not.toContain('MARKER-42');
    }
  });

  it('a title with < or > is refused', () => {
    const repo = minimal();
    write(repo, 'docs/t.md', page('x', 'body', 'title: "T</script><b>x"\n'));
    commit(repo, 't');
    expect(build(repo)).toMatchObject({ status: 1, stderr: expect.stringContaining('may not contain < or >') });
  });

  it('---js front matter is refused before anything evaluates it', () => {
    const marker = path.join(scratch, `ran-${n}`);
    const repo = minimal();
    write(
      repo,
      'docs/js.md',
      `---js\n{ title: require('fs').writeFileSync(${JSON.stringify(marker)}, 'x') }\n---\n\n# JS\n`,
    );
    commit(repo, 'js');
    expect(build(repo)).toMatchObject({ status: 1, stderr: expect.stringContaining('YAML') });
    expect(existsSync(marker)).toBe(false);
  });

  it('code-group and alert titles and an HTML page title reach no reader as code or markup', () => {
    const repo = minimal();
    write(
      repo,
      'docs/sinks.md',
      page(
        'Sinks',
        '::: code-group\n```sh [{{ 6*7 }}<form action=x>]\nx\n```\n:::\n\n> [!TIP] {{ 3*3 }} <form><input></form>\n> body',
        '',
      ),
    );
    commit(repo, 'sinks');
    expect(build(repo).status).toBe(0);
    const site = path.join(repo, '.specreview', 'site');
    // Rendered pages carry no form and no evaluated value; the title is
    // shown escaped in the sidebar. (Page data JSON holds the title as a
    // string, which VitePress never renders as markup.)
    for (const f of filesUnder(site).filter((x) => x.endsWith('.html'))) {
      const html = readFileSync(path.join(site, f), 'utf8');
      expect(html, f).not.toMatch(/<form/i);
      expect(html, f).not.toMatch(/>\s*(42|9)\s*</);
    }
    const chunk = filesUnder(path.join(site, 'assets')).find((x) => /^sinks\.md\.[^.]+\.js$/.test(x))!;
    const code = readFileSync(path.join(site, 'assets', chunk), 'utf8');
    // Interpolation would compile to code calling (6*7); here the titles are
    // literal text inside a static HTML string.
    expect(code).not.toMatch(/\(\s*6\s*\*\s*7\s*\)|\(\s*3\s*\*\s*3\s*\)/);
    expect(code).toContain('{{ 3*3 }}');
  });

  it('front matter VitePress acts on (head, layout) is refused', () => {
    for (const front of [
      'head:\n  - - script\n    - {}\n    - "window.__PWN_HEAD=1"\n',
      'layout: home\nhero:\n  text: "<form></form>"\n',
    ]) {
      const repo = minimal();
      write(repo, 'docs/fm.md', page('FM', 'x', front));
      commit(repo, 'fm');
      expect(build(repo), front).toMatchObject({
        status: 1,
        stderr: expect.stringContaining('front matter may hold only'),
      });
    }
  });

  it('{...} attributes do not reach Vue: no handler, no binding, the text shows', () => {
    const repo = minimal();
    write(
      repo,
      'docs/attrs.md',
      page('Attrs', `para two {@click="console.log('PWN_CLICK')"}\n\ny {:title="'PWN_BIND'+(6*7)"}`),
    );
    commit(repo, 'attrs');
    expect(build(repo).status).toBe(0);
    const site = path.join(repo, '.specreview', 'site');
    const html = readFileSync(path.join(site, 'attrs.html'), 'utf8');
    expect(html).not.toContain('PWN_BIND42');
    expect(html).toContain('@click');
    const chunks = filesUnder(path.join(site, 'assets')).filter((f) => f.startsWith('attrs.md'));
    for (const c of chunks) expect(readFileSync(path.join(site, 'assets', c), 'utf8')).not.toMatch(/onClick/);
  });

  it('symlinks in the docs folder are refused', () => {
    const repo = minimal();
    write(repo, 'src/config.txt', 'SECRET');
    mkdirSync(path.join(repo, 'docs', 'public'), { recursive: true });
    symlinkSync('../../src/config.txt', path.join(repo, 'docs', 'public', 'config.txt'));
    commit(repo, 'link');
    expect(build(repo)).toMatchObject({ status: 1, stderr: expect.stringContaining('symlinks are not allowed') });
  });

  it('public files: plain types are served at the site root; HTML and scripts are refused', () => {
    const repo = minimal();
    write(repo, 'docs/public/logo.png', 'png');
    commit(repo, 'logo');
    expect(build(repo).status).toBe(0);
    expect(existsSync(path.join(repo, '.specreview', 'site', 'logo.png'))).toBe(true);
    write(repo, 'docs/public/x.html', '<script>alert(1)</script>');
    commit(repo, 'html');
    expect(build(repo)).toMatchObject({ status: 1, stderr: expect.stringContaining('public/x.html') });
  });

  // macOS disks ignore case: DOCS is docs there.
  const caseInsensitive = existsSync(path.join(import.meta.dirname.toUpperCase()));
  it.runIf(caseInsensitive)('--out in other letter case is still the docs folder or .git', () => {
    const repo = minimal();
    for (const out of ['DOCS/gen', '.GIT/x']) {
      expect(build(repo, '--out', out), out).toMatchObject({ status: 1, stderr: expect.stringContaining('--out') });
    }
    expect(existsSync(path.join(repo, 'docs', 'gen'))).toBe(false);
  });

  it('--out . or .. deletes nothing', () => {
    const repo = minimal();
    writeFileSync(path.join(repo, '..', `sibling-${n}.txt`), 'keep');
    for (const out of ['.', '..', '.git', 'docs']) {
      expect(build(repo, '--out', out), out).toMatchObject({ status: 1, stderr: expect.stringContaining('--out') });
    }
    expect(existsSync(path.join(repo, '.git'))).toBe(true);
    expect(existsSync(path.join(repo, 'docs', 'index.md'))).toBe(true);
    expect(existsSync(path.join(repo, '..', `sibling-${n}.txt`))).toBe(true);
  });

  it('20, 21: forbidden features and names', () => {
    const cases: [string, string][] = [
      ['docs/inc.md', page('Inc', '<!--@include: ./index.md-->')],
      ['docs/inc.md', page('Inc in code', '`<!--@include: ../x.md-->`')],
      ['docs/my page.md', page('Space', 'x')],
      ['docs/_api/x.md', page('Api', 'x')],
    ];
    for (const [file, text] of cases) {
      const repo = minimal();
      write(repo, file, text);
      commit(repo, file);
      expect(build(repo), file).toMatchObject({
        status: 1,
        stderr: expect.stringContaining(file.slice('docs/'.length)),
      });
    }
  });

  it('24: bad arguments', () => {
    const repo = minimal();
    const run = (...args: string[]) => spawnSync('node', [CLI, ...args], { cwd: repo, encoding: 'utf8' });
    expect(run('build').stderr).toContain('usage');
    expect(run('publish', '--repo', 'x').stderr).toContain('usage');
    expect(run('build', '--repo', 'Fixture').stderr).toContain('--repo');
    expect(run('build', '--repo', 'x', '--docs', '..').stderr).toContain('inside the repository');
    expect(run('build', '--repo', 'x', '--out', 'docs/out').stderr).toContain('--out');
  });
});

describe('15, 18: where the docs are, and git states', () => {
  it('15: docs in a subfolder: history paths are relative to it', () => {
    const repo = newRepo();
    write(repo, 'product/specs/index.md', page('Home', 'x'));
    write(repo, 'product/specs/a/b.md', page('B', 'v1'));
    commit(repo, 'v1');
    write(repo, 'product/specs/a/b.md', page('B', 'v2'));
    commit(repo, 'v2');
    expect(build(repo, '--docs', 'product/specs').status).toBe(0);
    const m = manifestOf(repo);
    expect(m.pages['a/b'].history.map((h) => h.path)).toEqual(['a/b.md', 'a/b.md']);
    for (const h of m.pages['a/b'].history) {
      expect(existsSync(path.join(repo, '.specreview', 'history', h.commit, h.path))).toBe(true);
    }
  });

  it('18: detached HEAD builds that commit', () => {
    const repo = newRepo();
    write(repo, 'docs/index.md', page('Home', 'v1'));
    const first = commit(repo, 'v1');
    write(repo, 'docs/index.md', page('Home', 'v2'));
    commit(repo, 'v2');
    git(repo, 'checkout', '-q', '--detach', first);
    expect(build(repo).status).toBe(0);
    expect(manifestOf(repo).commit).toBe(first);
  });

  it('18: a merge that changes a page has a history entry matching the live page', () => {
    const repo = newRepo();
    write(repo, 'docs/index.md', page('Home', 'base'));
    commit(repo, 'base');
    git(repo, 'checkout', '-q', '-b', 'side');
    write(repo, 'docs/index.md', page('Home', 'from side'));
    commit(repo, 'side');
    git(repo, 'checkout', '-q', 'main');
    write(repo, 'docs/other.md', page('Other', 'x'));
    commit(repo, 'main moves on');
    // The merge itself changes the page, so its text is in neither parent.
    git(repo, 'merge', '-q', '--no-ff', '--no-commit', 'side');
    write(repo, 'docs/index.md', page('Home', 'settled in the merge'));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'Merge side (#9)');
    expect(build(repo).status).toBe(0);
    const entry = manifestOf(repo).pages.index;
    expect(entry.history.some((h) => h.hash === entry.hash)).toBe(true);
    expect(entry.history[0].pr).toBe(9);
  });

  it('a repo using SHA-256 object names is refused: the hub takes 40-hex commits', () => {
    const repo = path.join(scratch, `sha256-${++n}`);
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main', '--object-format=sha256');
    write(repo, 'docs/index.md', page('Home', 'x'));
    commit(repo, 'home');
    expect(build(repo)).toMatchObject({ status: 1, stderr: expect.stringContaining('not one the hub would accept') });
    // The pages were written before the manifest was refused; none are left.
    expect(existsSync(path.join(repo, '.specreview', 'site'))).toBe(false);
  });

  it('18: a depth-1 clone is refused until fully fetched', () => {
    const origin = newRepo();
    write(origin, 'docs/index.md', page('Home', 'v1'));
    commit(origin, 'v1');
    write(origin, 'docs/index.md', page('Home', 'v2'));
    commit(origin, 'v2');
    const clone = path.join(scratch, `clone${++n}`);
    git(scratch, 'clone', '-q', '--depth', '1', `file://${origin}`, clone);
    expect(build(clone)).toMatchObject({ status: 1, stderr: expect.stringContaining('full git history') });
    git(clone, 'fetch', '-q', '--unshallow');
    expect(build(clone).status).toBe(0);
    expect(manifestOf(clone).pages.index.history).toHaveLength(2);
  });
});

describe('#124: a page with no title is named after its file', () => {
  it('1-3, 5, 6, 8: an untitled page is named after its file, folder or repo, alike in the manifest and the sidebar', () => {
    const repo = newRepo();
    write(repo, 'docs/README.md', 'Start here.\n');
    write(repo, 'docs/plans/notes.md', 'No heading at all.\n');
    write(repo, 'docs/plans/fenced.md', '```sh\n# work, push\n```\n');
    write(repo, 'docs/plans/blank.md', '---\ntitle: "   "\n---\n\nText.\n');
    write(repo, 'docs/plans/named.md', '---\ntitle: Named here\n---\n\nText.\n');
    write(repo, 'docs/plans/marked.md', '# The `x` plan\n\nText.\n');
    write(repo, 'docs/plans/index.md', 'The plans folder.\n');
    write(repo, 'docs/plans/both.md', '---\ntitle: " "\n---\n\n# From the heading\n');
    commit(repo, 'docs');
    expect(build(repo)).toMatchObject({ status: 0 });
    const titles = Object.fromEntries(Object.entries(manifestOf(repo).pages).map(([k, v]) => [k, v.title]));
    expect(titles).toEqual({
      index: 'fixture',
      'plans/index': 'plans',
      'plans/both': 'From the heading',
      'plans/notes': 'notes',
      'plans/fenced': 'fenced',
      'plans/blank': 'blank',
      'plans/named': 'Named here',
      'plans/marked': 'The x plan',
    });
    // The sidebar names the untitled pages the same way.
    const sidebar = readFileSync(path.join(repo, '.specreview', 'site', 'plans/notes.html'), 'utf8');
    for (const name of ['fixture', 'plans', 'notes', 'fenced', 'blank', 'From the heading'])
      expect(sidebar).toMatch(new RegExp(`<(p|h2) class="text"[^>]*>${name}</(p|h2)>`));
  });
});

describe('#87: the whole repo as the docs folder, and a README home page', () => {
  const site = (repo: string, out = '.specreview') => path.join(repo, out, 'site');
  const minimal = () => {
    const repo = newRepo();
    write(repo, 'docs/index.md', page('Home', 'Text.'));
    commit(repo, 'docs: home');
    return repo;
  };

  it('1, 4, 7, 7a: a root build drops dot entries, serves the README as home with its history, and links to it resolve', () => {
    const repo = newRepo();
    write(repo, 'README.md', page('Team docs', 'Start here.'));
    commit(repo, 'docs: readme');
    write(repo, 'README.md', page('Team docs', 'Start here, [again](./README.md#top) and [the guide](guide/a.md).'));
    write(repo, 'guide/a.md', page('A', 'Back to [the start](../README.md), or [from the top](/README.md).'));
    write(repo, '.github/workflows/x.yml', 'name: x\n');
    write(repo, '.gitignore', '.specreview\n');
    const head = commit(repo, 'docs: a guide');
    const r = build(repo, '--docs', '.');
    expect(r).toMatchObject({ status: 0 });
    const files = filesUnder(site(repo));
    expect(files).toContain('index.html');
    expect(files).toContain('guide/a.html');
    expect(files.some((f) => f.startsWith('.') || f.includes('README'))).toBe(false);
    // The link itself, not the nav bar's: a README home page is at the site root.
    const hrefOf = (file: string, text: string) =>
      new RegExp(`<a href="([^"]*)"[^>]*>${text}</a>`).exec(readFileSync(path.join(site(repo), file), 'utf8'))?.[1];
    const at = (from: string, href: string | undefined) =>
      new URL(href ?? 'missing', `https://hub.example/fixture/${from}`);
    expect(at('guide/a', hrefOf('guide/a.html', 'the start')).pathname).toBe('/fixture/');
    expect(at('guide/a', hrefOf('guide/a.html', 'from the top')).pathname).toBe('/fixture/');
    const m = manifestOf(repo);
    expect(m.pages.index.title).toBe('Team docs');
    const again = at('', hrefOf('index.html', 'again'));
    expect([again.pathname, again.hash]).toEqual(['/fixture/', '#top']);
    expect(m.pages.index.history.map((h) => h.path)).toEqual(['README.md', 'README.md']);
    expect(existsSync(path.join(repo, '.specreview', 'history', head, 'README.md'))).toBe(true);
    expect(Object.keys(m.pages).sort()).toEqual(['guide/a', 'index']);
  });

  it('1a, 2: at the root, --out may not be committed, the repo itself or under .git', () => {
    const repo = newRepo();
    write(repo, 'index.md', page('Home', 'x'));
    write(repo, 'build/keep.md', page('Kept', 'x'));
    commit(repo, 'docs');
    expect(build(repo, '--docs', '.', '--out', 'build')).toMatchObject({
      status: 1,
      stderr: expect.stringContaining('--out build is committed in the repository'),
    });
    for (const out of ['.', '.git/x'])
      expect(build(repo, '--docs', '.', '--out', out), out).toMatchObject({
        status: 1,
        stderr: expect.stringContaining('--out must be a folder inside the repository'),
      });
  });

  it('3: below the root, --out inside the docs folder is still refused', () => {
    const repo = minimal();
    expect(build(repo, '--out', 'docs/x')).toMatchObject({
      status: 1,
      stderr: expect.stringContaining('--out must be a folder inside the repository, outside the docs folder'),
    });
  });

  it('5: any other file at the root goes through the checks', () => {
    const repo = newRepo();
    write(repo, 'index.md', page('Home', 'x'));
    write(repo, 'LICENSE', 'MIT\n');
    commit(repo, 'docs');
    expect(build(repo, '--docs', '.')).toMatchObject({ status: 1, stderr: expect.stringContaining('LICENSE') });
  });

  it('7b: a README home page linking out of the site fails the build and leaves no site', () => {
    const repo = newRepo();
    write(repo, 'docs/README.md', page('Home', 'See [outside](../outside.md).'));
    write(repo, 'outside.md', page('Outside', 'x'));
    commit(repo, 'docs');
    expect(build(repo)).toMatchObject({ status: 1, stderr: expect.stringMatching(/dead link/i) });
    expect(existsSync(site(repo))).toBe(false);
  });

  it('8, 10: with index.md, a README is an ordinary page, at the top and in a folder', () => {
    const repo = newRepo();
    write(repo, 'docs/index.md', page('Home', 'x'));
    write(repo, 'docs/README.md', page('Readme', 'x'));
    write(repo, 'docs/guide/README.md', page('Guide readme', 'x'));
    commit(repo, 'docs');
    expect(build(repo)).toMatchObject({ status: 0 });
    expect(Object.keys(manifestOf(repo).pages).sort()).toEqual(['README', 'guide/README', 'index']);
    expect(manifestOf(repo).pages.index.title).toBe('Home');
  });

  it('15: assets under dist are fine; only pages there are refused', () => {
    const repo = minimal();
    write(repo, 'docs/assets/dist/x.png', 'png');
    write(repo, 'docs/index.md', page('Home', '![x](./assets/dist/x.png)'));
    commit(repo, 'x');
    expect(build(repo)).toMatchObject({ status: 0 });
  });

  it('#87: a bad issues value on a README home page names README.md', () => {
    const repo = newRepo();
    write(repo, 'docs/README.md', page('Home', 'x', 'issues: [0]\n'));
    commit(repo, 'x');
    expect(build(repo)).toMatchObject({ status: 1, stderr: expect.stringContaining('README.md') });
  });

  it('15: pages under dist or node_modules are refused, since VitePress never builds them', () => {
    for (const folder of ['dist', 'node_modules', 'a/dist']) {
      const repo = minimal();
      write(repo, `docs/${folder}/x.md`, page('X', 'x'));
      commit(repo, 'x');
      expect(build(repo), folder).toMatchObject({ status: 1, stderr: expect.stringContaining(`${folder}/x.md`) });
    }
  });
});

describe('#88: paths left out of the site', () => {
  const site = (repo: string) => path.join(repo, '.specreview', 'site');
  const withPrototypes = () => {
    const repo = newRepo();
    write(repo, 'docs/index.md', page('Home', 'x'));
    write(repo, 'docs/product/spec.md', page('Spec', 'x'));
    write(repo, 'docs/product/prototypes/admin/Main.dc.html', '<html><script>x()</script></html>');
    write(repo, 'docs/product/prototypes/admin/support.js', 'x()');
    write(repo, 'docs/product/prototypes/admin/README.md', page('Prototype notes', '<script>bad()</script>'));
    write(repo, 'docs/product/report.pdf', 'pdf');
    write(repo, 'docs/drafts/wip.md', page('WIP', 'x'));
    commit(repo, 'docs');
    return repo;
  };

  it('1, 3: a folder of prototypes, with a symlink and a submodule in it, is left out; the rest builds', () => {
    const repo = withPrototypes();
    symlinkSync('/etc/hosts', path.join(repo, 'docs/product/prototypes/admin/link.md'));
    git(repo, 'add', '-A');
    git(repo, 'update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},docs/product/prototypes/sub`);
    commit(repo, 'symlink and submodule');
    expect(build(repo)).toMatchObject({ status: 1 });
    const r = build(repo, '--exclude', 'product/prototypes');
    expect(r).toMatchObject({ status: 0 });
    const files = filesUnder(site(repo));
    expect(files.some((f) => f.includes('prototypes'))).toBe(false);
    expect(files).toContain('product/spec.html');
    expect(Object.keys(manifestOf(repo).pages).sort()).toEqual(['drafts/wip', 'index', 'product/spec']);
  });

  it('2, 4: several patterns each leave out what they name; one matching nothing is fine', () => {
    const repo = withPrototypes();
    const r = build(
      repo,
      '--exclude',
      'product/prototypes',
      '--exclude',
      '**/*.pdf',
      '--exclude',
      'drafts/',
      '--exclude',
      'nothing/here',
    );
    expect(r).toMatchObject({ status: 0 });
    expect(Object.keys(manifestOf(repo).pages).sort()).toEqual(['index', 'product/spec']);
    expect(filesUnder(site(repo)).some((f) => f.endsWith('.pdf'))).toBe(false);
  });

  it('5: a bad pattern stops the build before anything is read', () => {
    const repo = withPrototypes();
    for (const bad of ['/abs', '../x', 'a/./b', 'a b', 'a**b'])
      expect(build(repo, '--exclude', bad), bad).toMatchObject({
        status: 1,
        stderr: expect.stringContaining(`--exclude ${JSON.stringify(bad)}`),
      });
    expect(existsSync(path.join(repo, '.specreview'))).toBe(false);
  });

  it('6: leaving out index.md falls back to a README.md; leaving out both says no home page', () => {
    const repo = newRepo();
    write(repo, 'docs/index.md', page('Index', 'x'));
    write(repo, 'docs/README.md', page('Readme home', 'x'));
    commit(repo, 'docs');
    expect(build(repo, '--exclude', 'index.md')).toMatchObject({ status: 0 });
    expect(manifestOf(repo).pages.index.title).toBe('Readme home');
    expect(build(repo, '--exclude', 'index.md', '--exclude', 'README.md')).toMatchObject({
      status: 1,
      stderr: expect.stringContaining('index.md or README.md is required'),
    });
  });

  it('7: the root as the docs folder takes excludes the same way', () => {
    const repo = newRepo();
    write(repo, 'README.md', page('Home', 'x'));
    write(repo, 'LICENSE', 'MIT\n');
    write(repo, 'tools/run.js', 'x()');
    commit(repo, 'docs');
    expect(build(repo, '--docs', '.', '--exclude', 'LICENSE', '--exclude', 'tools')).toMatchObject({ status: 0 });
  });

  it('history: versions from before a page was renamed out of a left-out path are not published', () => {
    const repo = newRepo();
    write(repo, 'docs/index.md', page('Home', 'x'));
    const body = Array.from({ length: 20 }, (_, i) => `Line ${i} of the guide.`).join('\n\n');
    write(repo, 'docs/drafts/secret.md', page('Guide', `${body}\n\nA draft note not for readers.`));
    commit(repo, 'draft');
    // A rename git recognises, so history follows it back into drafts/.
    git(repo, 'mv', 'docs/drafts/secret.md', 'docs/guide.md');
    write(repo, 'docs/guide.md', page('Guide', body));
    const head = commit(repo, 'publish the guide');
    expect(git(repo, 'log', '--follow', '--format=%H', '--', 'docs/guide.md').trim().split('\n')).toHaveLength(2);
    expect(build(repo, '--exclude', 'drafts')).toMatchObject({ status: 0 });
    const history = manifestOf(repo).pages.guide.history;
    expect(history.map((h) => h.path)).toEqual(['guide.md']);
    expect(history[0].commit).toBe(head);
    expect(filesUnder(path.join(repo, '.specreview', 'history')).some((f) => f.includes('drafts'))).toBe(false);
  });
});

describe('#97: files a page links are published at their path', () => {
  const site = (repo: string) => path.join(repo, '.specreview', 'site');

  it('1, 2, 3, 4: linked PDF and text files are copied; images are only emitted by VitePress; public/ and excluded files are not doubled', () => {
    const repo = newRepo();
    write(repo, 'docs/index.md', page('Home', 'See [notes](notes.txt).'));
    write(
      repo,
      'docs/product/spec.md',
      page('Spec', '[Model](payout-model.pdf), [notes](../notes.txt) and ![chart](chart.png)'),
    );
    write(repo, 'docs/product/payout-model.pdf', '%PDF-1.4 model');
    // Over Vite's 4 KB inline limit, so it is emitted under assets/ too.
    write(repo, 'docs/product/chart.png', 'p'.repeat(5000));
    write(repo, 'docs/notes.txt', 'plain notes');
    write(repo, 'docs/public/robots.txt', 'User-agent: *');
    write(repo, 'docs/drafts/old.pdf', '%PDF draft');
    // Not linked from any page: stays out, wherever it is.
    write(repo, 'docs/requirements.txt', 'secret-lib==1.0');
    write(repo, 'docs/product/internal.pdf', '%PDF internal');
    // A link in front matter is shown as text, so it does not count.
    write(repo, 'docs/product/titled.md', page('Titled', 'x', 'title: "[x](internal.pdf)"\n'));
    commit(repo, 'docs');
    expect(build(repo, '--exclude', 'drafts')).toMatchObject({ status: 0 });
    const files = filesUnder(site(repo));
    expect(readFileSync(path.join(site(repo), 'product/payout-model.pdf'), 'utf8')).toBe('%PDF-1.4 model');
    expect(readFileSync(path.join(site(repo), 'notes.txt'), 'utf8')).toBe('plain notes');
    // Images are VitePress's to emit (hashed, under assets/), not copied again.
    expect(files).not.toContain('product/chart.png');
    expect(files.some((f) => /^assets\/chart\.[\w-]+\.png$/.test(f))).toBe(true);
    expect(files).toContain('robots.txt');
    expect(files).not.toContain('public/robots.txt');
    expect(files.some((f) => f.startsWith('drafts'))).toBe(false);
    expect(files).not.toContain('requirements.txt');
    expect(files).not.toContain('product/internal.pdf');
    // The page's link resolves to the copied file.
    const href = /<a href="([^"]*)"[^>]*>Model<\/a>/.exec(
      readFileSync(path.join(site(repo), 'product/spec.html'), 'utf8'),
    )?.[1];
    expect(new URL(href ?? 'missing', 'https://hub.example/fixture/product/spec').pathname).toBe(
      '/fixture/product/payout-model.pdf',
    );
  });

  it('a file meeting another at one address stops the build, naming it', () => {
    const repo = newRepo();
    write(repo, 'docs/index.md', page('Home', '[a](a.txt)'));
    write(repo, 'docs/a.txt', 'beside the page');
    write(repo, 'docs/public/a.txt', 'from public');
    commit(repo, 'docs');
    expect(build(repo)).toMatchObject({
      status: 1,
      stderr: expect.stringContaining('a.txt: another file of the site is already published at /a.txt'),
    });
    expect(existsSync(site(repo))).toBe(false);
  });

  it("a file at a page's clean URL is refused, beside it or from public/", () => {
    for (const file of ['docs/guide.txt', 'docs/public/guide.txt']) {
      const repo = newRepo();
      write(repo, 'docs/index.md', page('Home', 'x'));
      write(repo, 'docs/guide.txt.md', page('Guide', 'x'));
      write(repo, file, 'shadow');
      commit(repo, 'docs');
      expect(build(repo), file).toMatchObject({
        status: 1,
        stderr: expect.stringContaining('would be served at the address of the page guide.txt.md'),
      });
    }
  });
});

describe('#102: Mermaid diagrams', () => {
  it('a mermaid block stays a code block, its source is in the section text, and Mermaid ships as site assets', () => {
    const repo = newRepo();
    write(
      repo,
      'docs/index.md',
      page('Home', '## Flow\n\nBefore.\n\n```mermaid\nflowchart LR\n  A["Write"] --> B["Review"]\n```\n\nAfter.'),
    );
    commit(repo, 'docs: diagram');
    expect(build(repo)).toMatchObject({ status: 0 });
    const site = path.join(repo, '.specreview', 'site');
    const html = readFileSync(path.join(site, 'index.html'), 'utf8');
    expect(html).toMatch(/<div class="language-mermaid[^"]*"/);
    expect(html).not.toContain('<svg');
    const flow = manifestOf(repo).pages.index.sections.find((s) => s.id === 'flow');
    expect(flow?.text).toContain('flowchart LR');
    const files = filesUnder(site);
    expect(files).toContain(`assets/mermaid-${MERMAID_VERSION}/mermaid.esm.min.mjs`);
    expect(files.filter((f) => f.startsWith(`assets/mermaid-${MERMAID_VERSION}/chunks/`)).length).toBeGreaterThan(50);
    expect(files.some((f) => f.startsWith('assets/mermaid-') && f.endsWith('.map'))).toBe(false);
    // #104: every script and stylesheet under assets/ is one the hub may let
    // browsers keep, except page chunks, which hold the page's text.
    const scripts = files.filter((f) => f.startsWith('assets/') && /\.(m?js|css)$/.test(f));
    const pageChunks = scripts.filter((f) => /^assets\/[^/]+\.md\.[\w-]{8}(\.lean)?\.js$/.test(f));
    expect(pageChunks.length).toBeGreaterThan(0);
    expect(pageChunks.filter(isContentAddressed)).toEqual([]);
    expect(scripts.filter((f) => !pageChunks.includes(f) && !isContentAddressed(f))).toEqual([]);
    expect(scripts.length - pageChunks.length).toBeGreaterThan(50);
    // Copied, not bundled: no Mermaid chunk from Vite.
    expect(files.some((f) => /^assets\/chunks\/mermaid/.test(f))).toBe(false);
  });

  it('a site with no mermaid block gets no copy of Mermaid', () => {
    const repo = newRepo();
    write(repo, 'docs/index.md', page('Home', '```ts\nconst a = 1;\n```'));
    commit(repo, 'docs: no diagram');
    expect(build(repo)).toMatchObject({ status: 0 });
    expect(filesUnder(path.join(repo, '.specreview', 'site')).some((f) => f.startsWith('assets/mermaid'))).toBe(false);
  });
});

describe('#101: a link into a left-out path', () => {
  const html = (repo: string, file: string) => readFileSync(path.join(repo, '.specreview', 'site', file), 'utf8');

  // The encoded link is excused (the build passes) and VitePress writes it decoded.
  it('1-7: is not a dead link; it points at the path from the site root, query and hash kept', () => {
    const repo = newRepo();
    write(
      repo,
      'docs/index.md',
      page(
        'Home',
        [
          '[proto](product/prototypes/x/Main.dc.html)',
          '[page](drafts/a.md)',
          '[folder](drafts/)',
          '[bare folder](drafts)',
          '[glob](notes.draft.md)',
          '[root](/drafts/a.md)',
          '[query](drafts/a.md?view=review#x)',
          '[encoded](%64rafts/a.md)',
          '[web](https://example.com/x) [mail](mailto:a@example.com) [hash](#top)',
        ].join('\n\n'),
      ),
    );
    write(repo, 'docs/guide/b.md', page('B', '[up](../drafts/a.md)'));
    write(repo, 'docs/drafts/a.md', page('A', 'x'));
    write(repo, 'docs/notes.draft.md', page('Notes', 'x'));
    write(repo, 'docs/product/prototypes/x/Main.dc.html', '<html></html>');
    commit(repo, 'docs');
    const r = build(repo, '--exclude', 'drafts', '--exclude', 'product/prototypes', '--exclude', '**/*.draft.md');
    expect(r).toMatchObject({ status: 0 });
    const index = html(repo, 'index.html');
    for (const href of [
      '/fixture/product/prototypes/x/Main.dc.html',
      '/fixture/drafts/a',
      '/fixture/drafts/',
      '/fixture/drafts',
      '/fixture/notes.draft',
      '/fixture/drafts/a?view=review#x',
      'https://example.com/x',
      'mailto:a@example.com',
      '#top',
    ])
      expect(index, href).toContain(`href="${href}"`);
    expect(html(repo, 'guide/b.html')).toContain('href="/fixture/drafts/a"');
    expect(Object.keys(manifestOf(repo).pages).sort()).toEqual(['guide/b', 'index']);
  });

  it('8, 9: every other dead link still fails, near misses included', () => {
    const repo = newRepo();
    write(
      repo,
      'docs/index.md',
      page(
        'Home',
        ['[missing](nope.md)', '[near](drafts-old/a.md)', '[html only](other/a)', '[no slash](idx)'].join('\n\n'),
      ),
    );
    write(repo, 'docs/drafts/a.md', page('A', 'x'));
    write(repo, 'docs/other/a.html', '<html></html>');
    write(repo, 'docs/idx/index.md', page('Idx', 'x'));
    commit(repo, 'docs');
    const r = build(repo, '--exclude', 'drafts', '--exclude', 'other/a.html', '--exclude', 'idx/index.md');
    expect(r.status).toBe(1);
    for (const link of ['./nope', './drafts-old/a', './other/a', './idx'])
      expect(r.stderr, link).toMatch(new RegExp(`dead link ${link.replace(/[.]/g, '\\.')}\\b`));
  });

  it('a docs-root link outside the left-out paths that shares an excused key still fails', () => {
    const repo = newRepo();
    // VitePress keys /a.html and /a.md alike; a.html is left out, a.md is missing.
    write(repo, 'docs/index.md', page('Home', '[left out](a.html)'));
    write(repo, 'docs/z.md', page('Z', '[missing](/a.md)'));
    write(repo, 'docs/a.html', '<html></html>');
    commit(repo, 'docs');
    const r = build(repo, '--exclude', 'a.html');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/dead link \/a\b/);
  });

  it('a missing docs-root link with a doubled suffix does not borrow an excused key', () => {
    const repo = newRepo();
    // VitePress reduces /a.md.md to /a, the key the left-out folder link has.
    // One page, so the excused key is recorded before this page's check whatever the render order.
    write(repo, 'docs/index.md', page('Home', '[left out](/a)\n\n[missing](/a.md.md)'));
    write(repo, 'docs/a/x.md', page('X', 'x'));
    commit(repo, 'docs');
    const r = build(repo, '--exclude', 'a');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/dead link \/a\b/);
  });

  it('a link that is only a query is left to VitePress, never rewritten into a left-out path', () => {
    const repo = newRepo();
    write(repo, 'docs/index.md', page('Home', 'x'));
    // VitePress reads a bare query as the folder's index, missing here: a dead
    // link, as before #101. Rewriting it to /guide?view=1 would excuse it.
    write(repo, 'docs/guide/x.md', page('X', '[same page](?view=1)'));
    write(repo, 'docs/guide.md', page('Old guide', 'x'));
    commit(repo, 'docs');
    const r = build(repo, '--exclude', 'guide.md');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/dead link \.\/index\b/);
  });

  it('with README.md as the home page (index.md left out), a link to the README still reaches the home page (no harm done)', () => {
    const repo = newRepo();
    write(repo, 'docs/README.md', page('Readme home', 'x'));
    write(repo, 'docs/index.md', page('Old home', 'x'));
    write(repo, 'docs/guide/c.md', page('C', '[home](../README.md)'));
    commit(repo, 'docs');
    expect(build(repo, '--exclude', 'index.md')).toMatchObject({ status: 0 });
    expect(html(repo, 'guide/c.html')).toMatch(/href="\/fixture\/"/);
  });
});

describe('#111: prototype folders published untouched', () => {
  const out = (repo: string, ...p: string[]) => path.join(repo, '.specreview', ...p);
  // Bytes no text decoder would keep: a NUL and an invalid UTF-8 sequence.
  const BINARY = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xc3, 0x28, 0xff, 0xfe]);
  const withPrototype = () => {
    const repo = newRepo();
    write(
      repo,
      'docs/index.md',
      page('Home', '[proto](product/prototypes/x/Main.dc.html) [missing](product/prototypes/x/gone.html)'),
    );
    write(repo, 'docs/product/spec.md', page('Spec', 'x'));
    write(repo, 'docs/product/prototypes/x/Main.dc.html', '<html><script>x()</script></html>');
    write(repo, 'docs/product/prototypes/x/support.js', 'window.x = () => 1;');
    write(repo, 'docs/product/prototypes/x/README.md', page('Notes', '<script>bad()</script>'));
    mkdirSync(path.join(repo, 'docs/product/prototypes/x/assets'), { recursive: true });
    writeFileSync(path.join(repo, 'docs/product/prototypes/x/assets/logo.png'), BINARY);
    write(repo, '.gitignore', 'docs/product/prototypes/x/ignored.js\n');
    commit(repo, 'docs');
    return repo;
  };

  it('1, 2, 11, 16: copied byte for byte as committed, left out of the site, listed with byte hashes', () => {
    const repo = withPrototype();
    write(repo, 'docs/product/prototypes/x/support.js', 'window.x = () => 2; // uncommitted');
    write(repo, 'docs/product/prototypes/x/untracked.js', 'u()');
    write(repo, 'docs/product/prototypes/x/ignored.js', 'i()');
    expect(build(repo, '--prototypes', 'product/prototypes')).toMatchObject({ status: 0 });
    const proto = filesUnder(out(repo, 'proto'));
    expect(proto).toEqual([
      'product/prototypes/x/Main.dc.html',
      'product/prototypes/x/README.md',
      'product/prototypes/x/assets/logo.png',
      'product/prototypes/x/support.js',
    ]);
    expect(readFileSync(out(repo, 'proto/product/prototypes/x/support.js'), 'utf8')).toBe('window.x = () => 1;');
    expect(readFileSync(out(repo, 'proto/product/prototypes/x/assets/logo.png')).equals(BINARY)).toBe(true);
    expect(filesUnder(out(repo, 'site')).some((f) => f.includes('product/prototypes'))).toBe(false);
    // The generated list (#114) is the one site file about them.
    expect(filesUnder(out(repo, 'site'))).toContain('prototypes.html');
    const manifest = manifestOf(repo);
    expect(Object.keys(manifest.pages).sort()).toEqual(['index', 'product/spec']);
    expect(manifest.prototypes).toEqual(
      proto.map((p) => ({
        path: p,
        hash: createHash('sha256')
          .update(readFileSync(out(repo, 'proto', p)))
          .digest('hex'),
      })),
    );
    expect(manifest.prototypes?.find((p) => p.path.endsWith('logo.png'))?.hash).toBe(
      createHash('sha256').update(BINARY).digest('hex'),
    );
    expect(isManifest(manifest)).toBe(true);
    expect(filesUnder(out(repo, 'history')).some((f) => f.includes('prototypes'))).toBe(false);
  });

  it('15: the same commit built twice gives the same prototypes and list', () => {
    const repo = withPrototype();
    expect(build(repo, '--prototypes', 'product/prototypes')).toMatchObject({ status: 0 });
    const first = manifestOf(repo).prototypes;
    expect(build(repo, '--prototypes', 'product/prototypes')).toMatchObject({ status: 0 });
    expect(manifestOf(repo).prototypes).toEqual(first);
  });

  it('without prototypes, no proto folder and no list in the manifest', () => {
    const repo = withPrototype();
    expect(build(repo, '--exclude', 'product/prototypes')).toMatchObject({ status: 0 });
    expect(existsSync(out(repo, 'proto'))).toBe(false);
    expect('prototypes' in manifestOf(repo)).toBe(false);
  });

  it('3: a symlink or a submodule in a prototype folder is refused', () => {
    const repo = withPrototype();
    symlinkSync('/etc/hosts', path.join(repo, 'docs/product/prototypes/x/link.js'));
    commit(repo, 'symlink');
    expect(build(repo, '--prototypes', 'product/prototypes')).toMatchObject({
      status: 1,
      stderr: expect.stringContaining(
        'docs/product/prototypes/x/link.js: symlinks are not allowed in a prototype folder',
      ),
    });
    const sub = withPrototype();
    git(sub, 'update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},docs/product/prototypes/sub`);
    // Straight to a commit: re-adding from disk would drop the submodule entry.
    git(sub, 'commit', '-q', '-m', 'submodule');
    expect(build(sub, '--prototypes', 'product/prototypes')).toMatchObject({
      status: 1,
      stderr: expect.stringContaining('submodules are not allowed in a prototype folder'),
    });
  });

  it('4: names outside the router grammar, reserved first segments and case-only clashes are refused', () => {
    const cases: [string, string, string][] = [
      ['docs/proto/a b.html', 'proto', 'prototype file names may use only'],
      ['docs/proto/.hidden.js', 'proto', 'prototype file names may use only'],
      ['docs/_api/x.html', '_api', 'may not start with _api, _history or _signin'],
    ];
    for (const [file, pattern, message] of cases) {
      const repo = newRepo();
      write(repo, 'docs/index.md', page('Home', 'x'));
      write(repo, file, 'x');
      commit(repo, 'docs');
      expect(build(repo, '--prototypes', pattern), file).toMatchObject({
        status: 1,
        stderr: expect.stringContaining(message),
      });
    }
    // Two names differing only in case: added straight to git, as a case-insensitive disk could not hold both.
    const repo = newRepo();
    write(repo, 'docs/index.md', page('Home', 'x'));
    write(repo, 'docs/proto/A.html', 'a');
    commit(repo, 'docs');
    const blob = git(repo, 'rev-parse', 'HEAD:docs/proto/A.html');
    git(repo, 'update-index', '--add', '--cacheinfo', `100644,${blob},docs/proto/a.html`);
    git(repo, 'commit', '-q', '-m', 'case');
    expect(build(repo, '--prototypes', 'proto')).toMatchObject({
      status: 1,
      stderr: expect.stringContaining('prototype paths may not differ only in case'),
    });
  });

  it('6, 8: bad patterns are refused before reading; a pattern matching nothing is refused', () => {
    const repo = withPrototype();
    for (const bad of ['/abs', '../x', 'a b'])
      expect(build(repo, '--prototypes', bad), bad).toMatchObject({
        status: 1,
        stderr: expect.stringContaining(`--prototypes ${JSON.stringify(bad)}`),
      });
    expect(build(repo, ...Array.from({ length: 21 }, (_, i) => ['--prototypes', `p${i}`]).flat())).toMatchObject({
      status: 1,
      stderr: expect.stringContaining('at most 20 --prototypes patterns'),
    });
    // A pattern whose matches are all excluded still matched: exclude wins quietly.
    expect(
      build(
        repo,
        '--prototypes',
        'product/prototypes',
        '--prototypes',
        'product/spec.md',
        '--exclude',
        'product/spec.md',
      ),
    ).toMatchObject({ status: 0 });
    expect(build(repo, '--prototypes', 'product/prototypes', '--prototypes', 'product/nothing')).toMatchObject({
      status: 1,
      stderr: expect.stringContaining('--prototypes "product/nothing" matches no committed file'),
    });
  });

  it('7, 9: a glob takes every matching folder; a path also excluded stays out', () => {
    const repo = withPrototype();
    write(repo, 'docs/guide/prototypes/y/Main.html', '<html></html>');
    commit(repo, 'second');
    expect(build(repo, '--prototypes', '**/prototypes', '--exclude', 'product/prototypes/x/assets')).toMatchObject({
      status: 0,
    });
    const proto = filesUnder(out(repo, 'proto'));
    expect(proto).toContain('guide/prototypes/y/Main.html');
    expect(proto).toContain('product/prototypes/x/Main.dc.html');
    expect(proto.some((f) => f.includes('assets'))).toBe(false);
  });

  it('10: with the docs folder at the root, prototypes are copied', () => {
    const repo = newRepo();
    write(repo, 'index.md', page('Home', 'x'));
    write(repo, 'proto/a.html', '<html></html>');
    write(repo, '.github/workflows/x.yml', 'x');
    commit(repo, 'root');
    expect(build(repo, '--docs', '.', '--prototypes', 'proto')).toMatchObject({ status: 0 });
    expect(filesUnder(out(repo, 'proto'))).toEqual(['proto/a.html']);
  });

  it('5, 14: a build over the hub limits is refused with the counts and leaves no proto folder', () => {
    const big = withPrototype();
    writeFileSync(path.join(big, 'docs/product/prototypes/x/video.bin'), Buffer.alloc(25 * 1024 * 1024, 1));
    commit(big, 'big');
    expect(build(big, '--prototypes', 'product/prototypes')).toMatchObject({
      status: 1,
      stderr: expect.stringMatching(/the build would upload 2\d\.\d MB; the hub takes at most 25 MB/),
    });
    expect(existsSync(out(big, 'proto'))).toBe(false);
    const many = withPrototype();
    for (let i = 0; i < 5000; i++) write(many, `docs/product/prototypes/x/n/${i}.js`, String(i));
    commit(many, 'many');
    expect(build(many, '--prototypes', 'product/prototypes')).toMatchObject({
      status: 1,
      stderr: expect.stringMatching(/the build has 5\d{3} files; the hub takes at most 5000/),
    });
    expect(existsSync(out(many, 'proto'))).toBe(false);
  });

  it('set-aside files that differ from the committed list (a file .gitattributes leaves out of the archive) are refused', () => {
    const repo = withPrototype();
    write(repo, '.gitattributes', 'docs/product/prototypes/x/support.js export-ignore\n');
    commit(repo, 'export-ignore');
    expect(build(repo, '--prototypes', 'product/prototypes')).toMatchObject({
      status: 1,
      stderr: expect.stringContaining('the prototype files unpacked differ from those committed'),
    });
  });

  it('the multipart framing counts: long names push a build just under 25 MB of bytes over', () => {
    const repo = withPrototype();
    const longName = 'n'.repeat(120);
    // 4800 files of 5.1 KB: about 23.3 MB of bytes, under 25 MB on their own by about 5%, over it by about 5% once each part's framing counts.
    for (let i = 0; i < 4800; i++) write(repo, `docs/product/prototypes/x/${longName}/${i}.txt`, 'x'.repeat(5100));
    commit(repo, 'long names');
    expect(build(repo, '--prototypes', 'product/prototypes')).toMatchObject({
      status: 1,
      stderr: expect.stringMatching(/the build would upload 2\d\.\d MB; the hub takes at most 25 MB/),
    });
  });

  it('a page renamed from a prototype path keeps none of the prototype as history', () => {
    const repo = newRepo();
    write(repo, 'docs/index.md', page('Home', 'x'));
    write(repo, 'docs/proto/notes.md', page('Notes', 'old prototype text'));
    commit(repo, 'first');
    git(repo, 'mv', 'docs/proto/notes.md', 'docs/notes.md');
    write(repo, 'docs/proto/a.html', '<html></html>');
    commit(repo, 'move');
    expect(build(repo, '--prototypes', 'proto')).toMatchObject({ status: 0 });
    expect(manifestOf(repo).pages.notes.history.some((h) => h.path.startsWith('proto/'))).toBe(false);
  });
});

describe('#113: links into prototype folders', () => {
  const html = (repo: string, file: string) => readFileSync(path.join(repo, '.specreview', 'site', file), 'utf8');

  it('1-3, 7: only a link the hub redirects leaves the in-site router', () => {
    const repo = newRepo();
    write(
      repo,
      'docs/index.md',
      page(
        'Home',
        [
          '[proto](proto/x/Main.html?view=1#top)',
          '[folder](proto/y/)',
          '[drafts](drafts/a.md)',
          '[both](proto/z/Gone.html)',
          '[one file](proto/w/a.html)',
          '[no slash](proto/y)',
          '[encoded](proto/x/Main%2Ehtml)',
        ].join('\n\n'),
      ),
    );
    write(repo, 'docs/proto/x/Main.html', '<html></html>');
    write(repo, 'docs/proto/y/index.html', '<html></html>');
    write(repo, 'docs/proto/z/Gone.html', '<html></html>');
    write(repo, 'docs/proto/w/a.html', '<html></html>');
    write(repo, 'docs/proto/w/b.html', '<html></html>');
    write(repo, 'docs/drafts/a.md', page('A', 'x'));
    // #126: from a nested page, relative and docs-root links get the same.
    write(repo, 'docs/guide/deep.md', page('Deep', '[up](../proto/x/Main.html)\n\n[root](/proto/y/)'));
    commit(repo, 'docs');
    const args = [
      '--prototypes',
      'proto',
      '--exclude',
      'drafts',
      '--exclude',
      'proto/z',
      '--exclude',
      'proto/w/a.html',
    ];
    expect(build(repo, ...args)).toMatchObject({ status: 0 });
    const index = html(repo, 'index.html');
    expect(index).toMatch(/<a href="\/fixture\/proto\/x\/Main\.html\?view=1#top" target="_blank" rel="noopener">/);
    expect(index).toMatch(/<a href="\/fixture\/proto\/y\/" target="_blank" rel="noopener">/);
    expect(index).toMatch(/<a href="\/fixture\/drafts\/a">/);
    expect(index).toMatch(/<a href="\/fixture\/proto\/z\/Gone\.html">/);
    // An exact exclusion under a prototype folder wins over the folder.
    expect(index).toMatch(/<a href="\/fixture\/proto\/w\/a\.html">/);
    // The hub redirects a folder only with its slash; without it, the 404 page.
    expect(index).toMatch(/<a href="\/fixture\/proto\/y">/);
    // The hub never decodes a path, so an encoded name is not the prototype:
    // it stays an excused link (markdown-it prints it decoded) and reaches the 404 page.
    expect(index).toMatch(/<a href="\/fixture\/proto\/x\/Main\.html">encoded<\/a>/);
    expect(index.match(/target="_blank" rel="noopener"/g)).toHaveLength(2);
    expect(index).not.toContain('_self');
    const deep = html(repo, 'guide/deep.html');
    expect(deep).toMatch(/<a href="\/fixture\/proto\/x\/Main\.html" target="_blank" rel="noopener">up<\/a>/);
    expect(deep).toMatch(/<a href="\/fixture\/proto\/y\/" target="_blank" rel="noopener">root<\/a>/);
  });

  it('a prototype path the site also serves is refused', () => {
    const repo = newRepo();
    write(repo, 'docs/index.md', page('Home', 'x'));
    write(repo, 'docs/proto/notes.txt', 'proto');
    write(repo, 'docs/public/proto/notes.txt', 'public');
    commit(repo, 'docs');
    expect(build(repo, '--prototypes', 'proto')).toMatchObject({
      status: 1,
      stderr: expect.stringContaining('proto/notes.txt: the site also serves proto/notes.txt at that address'),
    });
  });

  it('a prototype a page shadows at its .html address is refused', () => {
    const repo = newRepo();
    write(repo, 'docs/index.md', page('Home', 'x'));
    write(repo, 'docs/guide', '<html></html>');
    write(repo, 'docs/guide.md', page('Guide', 'x'));
    commit(repo, 'docs');
    expect(build(repo, '--prototypes', 'guide')).toMatchObject({
      status: 1,
      stderr: expect.stringContaining('guide: the site also serves guide.html at that address'),
    });
  });

  it('a prototype under assets/ is refused', () => {
    const repo = newRepo();
    write(repo, 'docs/index.md', page('Home', 'x'));
    write(repo, 'docs/assets/demo.html', '<html></html>');
    commit(repo, 'docs');
    expect(build(repo, '--prototypes', 'assets')).toMatchObject({
      status: 1,
      stderr: expect.stringContaining('assets/demo.html: a prototype may not be under assets/'),
    });
  });
});

describe('#114: the generated Prototypes page', () => {
  const html = (repo: string, file: string) => readFileSync(path.join(repo, '.specreview', 'site', file), 'utf8');

  it('1-3, 6, 10: lists the published pages, leaves the router, is not reviewed, and is covered by the CSP', () => {
    const repo = newRepo();
    write(repo, 'docs/index.md', page('Home', 'x'));
    write(repo, 'docs/first.md', page('First', 'x', 'order: 1\n'));
    write(repo, 'docs/zeta.md', page('Zeta', 'x'));
    write(repo, 'docs/proto/x/Main.html', '<title>Main screen</title>');
    write(
      repo,
      'docs/proto/x/odd.html',
      '<title><b>A</b> &amp; *x* {{ 1+1 }} https://e.example :smile: &copy;</title>',
    );
    write(repo, 'docs/proto/x/Gone.html', '<title>Gone</title>');
    write(repo, 'docs/proto/y/index.html', '<title>Y</title>');
    commit(repo, 'docs');
    expect(build(repo, '--prototypes', 'proto', '--exclude', 'proto/x/Gone.html')).toMatchObject({ status: 0 });
    const list = html(repo, 'prototypes.html');
    expect(list).toMatch(/<a href="\/fixture\/proto\/x\/Main\.html" target="_blank" rel="noopener">Main screen<\/a>/);
    // #136: folder headings without the shared proto/.
    expect([...list.matchAll(/<h2 id="[^"]*" tabindex="-1">([^<]*)</g)].map((m) => m[1].trim())).toEqual(['x', 'y']);
    expect(list).toMatch(/<a href="\/fixture\/proto\/y\/" target="_blank" rel="noopener">Y<\/a>/);
    expect(list.match(/target="_blank" rel="noopener"/g)).toHaveLength(3);
    expect(list).not.toContain('_self');
    expect(list).not.toContain('Gone');
    // The odd title is text: no element, and Vue interpolated nothing (no 2).
    const odd =
      /<a href="\/fixture\/proto\/x\/odd\.html" target="_blank" rel="noopener">([^]*?)<\/a>/.exec(list)?.[1] ?? '';
    expect(odd).toContain('&lt;b&gt;A&lt;/b&gt; &amp; *x*');
    expect(odd).toContain('{{ 1+1 }}');
    // Neither linkify nor the emoji plugin acts on it; the entity is decoded once.
    expect(odd).toContain('https://e.example :smile: \u00a9');
    expect(odd).not.toMatch(/<[a-z]|\b2\b/i);
    // Last in the sidebar: after a page ordered first and one whose title sorts after it.
    const data = /window\.__VP_SITE_DATA__=([^<]*)<\/script>/.exec(html(repo, 'index.html'))?.[1] ?? '';
    expect(data.lastIndexOf('First')).toBeGreaterThan(-1);
    expect(data.lastIndexOf('Prototypes')).toBeGreaterThan(data.lastIndexOf('Zeta'));
    expect(data.lastIndexOf('Zeta')).toBeGreaterThan(data.lastIndexOf('First'));
    const m = manifestOf(repo);
    expect(Object.keys(m.pages).sort()).toEqual(['first', 'index', 'zeta']);
    let scripts = 0;
    for (const [, code] of list.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
      if (code.trim() === '') continue;
      scripts++;
      expect(m.csp).toContain(`'sha256-${createHash('sha256').update(code).digest('base64')}'`);
    }
    expect(scripts).toBeGreaterThan(0);
  });

  it('7, 9: without prototypes there is no generated page, and an author prototypes.md is an ordinary page', () => {
    const repo = newRepo();
    write(repo, 'docs/index.md', page('Home', 'x'));
    write(repo, 'docs/prototypes.md', page('Prototypes', 'written by hand'));
    commit(repo, 'docs');
    expect(build(repo)).toMatchObject({ status: 0 });
    expect(html(repo, 'prototypes.html')).toContain('written by hand');
    expect(Object.keys(manifestOf(repo).pages).sort()).toEqual(['index', 'prototypes']);
    const bare = newRepo();
    write(bare, 'docs/index.md', page('Home', 'x'));
    commit(bare, 'docs');
    expect(build(bare)).toMatchObject({ status: 0 });
    expect(existsSync(path.join(bare, '.specreview', 'site', 'prototypes.html'))).toBe(false);
  });

  it.each([
    'prototypes.md',
    'prototypes/index.md',
    'prototypes.html.md',
    'Prototypes.md',
    'prototypes.html/a.md',
    'Prototypes.MD/a.md',
  ])('8: a docs page at %s is refused when the build lists prototypes', (file) => {
    const repo = newRepo();
    write(repo, 'docs/index.md', page('Home', 'x'));
    write(repo, `docs/${file}`, page('Mine', 'x'));
    write(repo, 'docs/proto/a.html', '<title>A</title>');
    commit(repo, 'docs');
    expect(build(repo, '--prototypes', 'proto')).toMatchObject({
      status: 1,
      stderr: expect.stringContaining(`${file}: the build adds a generated Prototypes page (prototypes.md)`),
    });
  });

  it('8b: a prototype at the generated page address is refused', () => {
    const repo = newRepo();
    write(repo, 'docs/index.md', page('Home', 'x'));
    write(repo, 'docs/prototypes.html', '<title>P</title>');
    commit(repo, 'docs');
    expect(build(repo, '--prototypes', 'prototypes.html')).toMatchObject({
      status: 1,
      stderr: expect.stringContaining('prototypes.html: the site also serves prototypes.html at that address'),
    });
  });
});
