import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkArguments, checkPaths, forbiddenIn, OUTPUT_MARK } from './checks.js';
import { docsAsPagesOrAssets } from './config.js';

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

  it("#79: a code block's first word is letters, digits and _+.#{},:=- only, wherever the fence is", () => {
    const fenced = (opener: string) => `# Page\n\n${opener}\nx\n\`\`\`\n`;
    for (const ok of [
      '```ts',
      '```js{1,3-4}',
      '```sh [pnpm]',
      '```ts:line-numbers=5',
      '```md:no-line-numbers',
      '```ts twoslash',
      '```vue-html',
      '```c#',
      '~~~',
      '```',
    ])
      expect(forbiddenIn(fenced(ok)), ok).toBeNull();
    for (const bad of [
      '```##[add-mask]x',
      '```##&#91;add-mask&#93;x',
      '```ts:##&#91;add-mask&#93;x',
      '```js{##&#91;add-mask&#93;x}',
      '~~~a"b',
      '- ```##&#91;error&#93;x',
      '> ```##&#91;error&#93;x',
      '1. ```a\\[b',
    ])
      expect(forbiddenIn(fenced(bad)), bad).toBe('code block languages other than letters, digits and _+.#{},:=-');
  });

  it('code is what markdown-it parses as code: a fence marker indented four spaces opens nothing', () => {
    expect(forbiddenIn('# Page\n\nText.\n\n    ```\n<script setup>\nx\n</script>\n')).toBe('script blocks');
    expect(forbiddenIn('# Page\n\n   ```\n<script setup>\n   ```\n')).toBeNull();
    expect(forbiddenIn('# Page\n\n    <script setup>\n')).toBeNull();
    expect(forbiddenIn('# Page\n\n- item\n\n  ```\n  <script>\n  ```\n')).toBeNull();
  });

  it('every form of a snippet import is refused: no space, indented up to three, nested, after a paragraph', () => {
    for (const page of [
      '<<</etc/hosts',
      '<<<@/x.js',
      '   <<< /etc/hosts',
      '- <<< /etc/hosts',
      '1. <<< /etc/hosts',
      '> <<< /etc/hosts',
      '> - > <<< /etc/hosts',
      '::: tip\n<<< /etc/hosts\n:::',
      '::: details Title\n- <<< /etc/hosts\n:::',
      'Some text\n<<< /etc/hosts',
      ' \t<<< x\n\nand\n\n<<<x',
    ])
      expect(forbiddenIn(`# Page\n\n${page}\n`), page).toBe('snippet imports (<<<)');
  });

  it('a fence inside a container ends with it, so what follows is checked', () => {
    expect(forbiddenIn('# Page\n\n::: tip\n```\n:::\n<<< /etc/hosts\n')).toBe('snippet imports (<<<)');
    expect(forbiddenIn('# Page\n\n::: code-group\n```sh\n:::\n<script setup>\n')).toBe('script blocks');
  });

  it('a fence marker in front matter hides nothing in the page', () => {
    // Read as Markdown, the block scalar's line would open a fence running to the end.
    expect(forbiddenIn('---\ntitle: |\n  ```\n---\n\n# Page\n\n<<< /etc/hosts\n')).toBe('snippet imports (<<<)');
    expect(forbiddenIn('---\ntitle: <script>\n---\n\n# Page\n')).toBe('script blocks');
  });

  it('<<< in code is fine: indented four columns (a tab is four), fenced, or inline', () => {
    for (const page of ['    <<< /etc/hosts', '\t<<< x', '```\n<<< /etc/hosts\n```', 'Write `<<< file` to import.'])
      expect(forbiddenIn(`# Page\n\n${page}\n`), page).toBeNull();
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
    ['_signin.md'],
    ['_api.md'],
    ['_history.md'],
    ['_signin/x.md'],
    ['public/_signin'],
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

  // #73: outside public/, only pages and the same types public/ takes.
  it.each([
    ['probe.js'],
    ['probe.mjs'],
    ['probe.ts'],
    ['probe.vue'],
    ['probe.svg'],
    ['probe.html'],
    ['probe.css'],
    ['probe.json'],
    ['guide/deep/probe.js'],
    ['img/probe.svg'],
    ['notes'],
    ['notes.v2/readme'],
    ['data.csv'],
    ['probe.MD'],
    ['guide/probe.Md'],
  ])('%s outside public/ is refused, naming the file', (file) => {
    expect(() => checkPaths(['index.md', file])).toThrow(
      `${file}: outside public/, the docs folder takes only .md pages and png, jpg, jpeg, gif, webp, ico, pdf, txt, woff, woff2 files`,
    );
  });

  it('csv stays allowed in public/, which is copied and never imported', () => {
    expect(() => checkPaths(['index.md', 'public/data.csv'])).not.toThrow();
  });

  it('pages and every asset type are accepted outside public/, assets in either case', () => {
    const types = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'pdf', 'txt', 'woff', 'woff2'];
    expect(() =>
      checkPaths(['index.md', 'guide/a.md', ...types.map((t) => `img/x.${t}`), 'img/Shot.PNG']),
    ).not.toThrow();
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

  it.each([['Sidecar'], ['acme/sidecar'], ['..'], [''], ['a b']])('repo %j is refused', (repo) => {
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

describe('#73: docs files load only as pages or plain assets', () => {
  let docs: string;
  let other: string;
  beforeEach(() => {
    docs = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'site-docs-')));
    other = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'site-other-')));
    for (const f of ['index.md', 'img.png', 'Shot.PNG', 'upper.MD', 'notes.txt'])
      writeFileSync(path.join(docs, f), 'x');
    writeFileSync(path.join(other, 'lib.js'), 'x');
  });
  afterEach(() => {
    rmSync(docs, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  });
  const load = (id: string) => docsAsPagesOrAssets(docs).load(id);

  it('a page with any query, and a plain asset, load', () => {
    expect(load(path.join(docs, 'index.md'))).toBeNull();
    expect(load(`${path.join(docs, 'index.md')}?vue&type=script&lang.ts`)).toBeNull();
    expect(load(path.join(docs, 'img.png'))).toBeNull();
    expect(load(path.join(docs, 'Shot.PNG'))).toBeNull();
    expect(load(path.join(docs, 'notes.txt'))).toBeNull();
  });

  it.each(['?worker', '?sharedworker', '?raw', '?url', '?inline', '?import'])('an asset with %s is refused', (q) => {
    expect(() => load(`${path.join(docs, 'img.png')}${q}`)).toThrow(
      'img.png: a page may use this file only as a plain image or link',
    );
  });

  it.each(['?worker', '?raw', '?url'])('a page with %s is refused', (q) => {
    expect(() => load(`${path.join(docs, 'index.md')}${q}`)).toThrow('index.md: a page may use this file only');
  });

  it('an upper-case .MD is not a page and is refused', () => {
    expect(() => load(path.join(docs, 'upper.MD'))).toThrow('upper.MD: a page may use this file only');
  });

  it('files outside the docs folder and virtual modules are left to the other checks', () => {
    expect(load(path.join(other, 'lib.js'))).toBeNull();
    expect(load('\0virtual:thing')).toBeNull();
    expect(load('vitepress/theme')).toBeNull();
  });
});

describe('#88: what an exclude pattern leaves out', () => {
  it('a plain path is a file or a whole folder; * stays in one name; ** crosses folders; case counts', async () => {
    const { excludedBy } = await import('./checks.js');
    const cases: [string, string[], string[]][] = [
      [
        'product/prototypes',
        ['product/prototypes/a/m.html', 'product/prototypes/s.js'],
        ['product/prototypes2/x.md', 'product/spec.md'],
      ],
      ['drafts/', ['drafts/x.md'], ['drafts.md', 'old/drafts/x.md']],
      ['*.pdf', ['y.pdf'], ['x/f.pdf', 'yXpdf']],
      ['**/*.pdf', ['y.pdf', 'x/f.pdf', 'a/b/c.pdf'], ['x/f.pdfx']],
      ['product/proto*', ['product/protos/k.md', 'product/prototypes/s.js'], ['product/spec.md']],
      ['a/**/b', ['a/b', 'a/x/b', 'a/x/y/b/z.md'], ['a/xb', 'b']],
      ['Drafts', ['Drafts/x.md'], ['drafts/x.md']],
    ];
    for (const [pattern, gone, kept] of cases) {
      const out = excludedBy([pattern]);
      for (const f of gone) expect(out(f), `${pattern} leaves out ${f}`).toBe(true);
      for (const f of kept) expect(out(f), `${pattern} keeps ${f}`).toBe(false);
    }
    expect(excludedBy([])('anything.md')).toBe(false);
  });

  it('checkExcludes refuses bad shapes and more than 20, naming the pattern', async () => {
    const { checkExcludes } = await import('./checks.js');
    expect(() => checkExcludes(['../x'])).toThrow('--exclude "../x"');
    expect(() => checkExcludes(Array.from({ length: 21 }, (_, i) => `p${i}`))).toThrow('at most 20');
    expect(() => checkExcludes(Array.from({ length: 20 }, (_, i) => `p${i}`))).not.toThrow();
  });
});
