import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import MarkdownIt from 'markdown-it';
import { afterEach, describe, expect, it } from 'vitest';
import { siteShape } from './config.js';
import { headingsFor, markdownText, prototypesPage, titleIn } from './prototypes-page.js';

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'protos-page-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const put = (dir: string, file: string, body: string) => {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), body);
};

describe('#114: the title of a prototype page', () => {
  it('3: is the first <title> as text, entities decoded once, tags kept as text', () => {
    expect(titleIn('<title>Checkout &amp;amp; <b>pay</b></title><title>second</title>')).toBe(
      'Checkout &amp; <b>pay</b>',
    );
    expect(titleIn('<TITLE lang="en">A &lt;b&gt; &#65;&#x42; &nbsp;C</TITLE>')).toBe('A <b> AB C');
    expect(titleIn('<title>&copy; &mdash; &eacute; &#0; &bogus;</title>')).toBe('\u00a9 \u2014 \u00e9 \ufffd &bogus;');
  });

  it('3: is the one a browser shows, not one in a comment, script, style or inline SVG', () => {
    const html =
      '<!-- <title>comment</title> --><style>/* <title>css</title> */</style><script>"<title>js</title>"</script>' +
      '<title>Real</title><svg><title>icon</title></svg>';
    expect(titleIn(html)).toBe('Real');
    expect(titleIn('<svg><title>icon</title></svg><p>x</p>')).toBeNull();
    expect(titleIn('<!-- <title>never closed')).toBeNull();
    expect(titleIn('<template><title>x</title></template><TITLE>Real</TITLE>')).toBe('Real');
    expect(titleIn('<SCRIPT>"</script x>"</SCRIPT ><title>Real</title>')).toBe('Real');
    expect(titleIn('<script>var s = "<!--"</script><title>Real</title>')).toBe('Real');
    expect(titleIn('<script><title>never closed')).toBeNull();
    expect(titleIn('<!--><title>Real</title>')).toBe('Real');
    expect(titleIn('<!---><title>Real</title>')).toBe('Real');
  });

  it('3: reads the title as text: tag-like words in it stay, quotes and custom elements do not confuse it', () => {
    expect(titleIn('<title>Inline <svg> icons and <style> and <script></title>')).toBe(
      'Inline <svg> icons and <style> and <script>',
    );
    expect(titleIn('<title>a <!-- b</title>')).toBe('a <!-- b');
    expect(titleIn('<title data-x="a>b">T</title>')).toBe('T');
    expect(titleIn('<title-bar>Brand</title-bar><svg-icon>i</svg-icon><title>Real</title foo>')).toBe('Real');
    expect(titleIn('<title>a &amp b &copy c</title>')).toBe('a & b \u00a9 c');
  });

  it('a hostile file is read in one pass', () => {
    const started = Date.now();
    expect(titleIn('<title>'.repeat(400_000))).toBeNull();
    expect(titleIn('<title'.repeat(400_000))).toBeNull();
    expect(titleIn('<script>'.repeat(400_000))).toBeNull();
    expect(titleIn('<!--'.repeat(400_000))).toBeNull();
    expect(titleIn("<a title='".repeat(400_000))).toBeNull();
    // #122: nesting counted in one pass; unquoted values.
    expect(titleIn('<svg>'.repeat(400_000))).toBeNull();
    expect(titleIn(`${'<svg>'.repeat(200_000)}${'</svg>'.repeat(200_000)}<title>T</title>`)).toBe('T');
    expect(titleIn('<img alt=x'.repeat(400_000))).toBeNull();
    expect(titleIn(`<svg>${"<a b='".repeat(400_000)}`)).toBeNull();
    expect(titleIn(`<svg>${'<!--'.repeat(400_000)}`)).toBeNull();
    expect(titleIn(`<template>${'<script>'.repeat(400_000)}`)).toBeNull();
    expect(titleIn(`<svg>${'<a>'.repeat(400_000)}`)).toBeNull();
    expect(titleIn(`<template>${'<script></script>'.repeat(200_000)}`)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('4: is null with no title or a blank one, and cut to 120 characters', () => {
    expect(titleIn('<html><body>no title</body></html>')).toBeNull();
    expect(titleIn('<title>  \n\t </title>')).toBeNull();
    expect([...(titleIn(`<title>${'é'.repeat(300)}</title>`) ?? '')]).toHaveLength(120);
    // A bidi control is removed, not a space (#122).
    expect(titleIn('<title>a\u0000b‮c\n\nd</title>')).toBe('a bc d');
  });

  it('3: escaped, it renders as the same text and makes no element, link or interpolation', () => {
    const md = new MarkdownIt({ html: false });
    const title = '<b>A</b> & *x* [y](z) {{ 1+1 }} # `c` \\ ~~s~~ ![i](j) <https://e.example>';
    const html = md.renderInline(markdownText(title));
    expect(html).not.toMatch(/<\/?[a-z]/i);
    expect(
      html
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"'),
    ).toBe(title);
  });
});

describe('#114: the generated page', () => {
  it('1, 2, 5: one row per HTML page by folder, top level first, folders with their slash', () => {
    const proto = tempDir();
    put(proto, 'proto/x/Main.html', '<title>Main screen</title>');
    put(proto, 'proto/x/b.html', '<p>no title</p>');
    put(proto, 'proto/y/index.html', '<title>Y</title>');
    put(proto, 'proto/x/app.js', '');
    put(proto, 'proto/x/style.css', '');
    put(proto, 'proto/x/logo.png', '');
    put(proto, 'top.html', '<title>Top</title>');
    const files = [
      'proto/x/Main.html',
      'proto/x/app.js',
      'proto/x/b.html',
      'proto/x/logo.png',
      'proto/x/style.css',
      'proto/y/index.html',
      'top.html',
    ];
    const page = prototypesPage(files, proto);
    expect(page).toContain('title: Prototypes');
    const body = page.slice(page.indexOf('# Prototypes'));
    expect(body.split('\n').filter((l) => /^(## |- )/.test(l))).toEqual([
      '- [Top](/top.html)',
      '## x',
      '- [Main screen](/proto/x/Main.html)',
      '- [b\\.html](/proto/x/b.html)',
      '## y',
      '- [Y](/proto/y/)',
    ]);
    expect(page).not.toMatch(/app\.js|style\.css|logo\.png/);
  });

  it('122: titles read as the browser reads them', () => {
    // 1-4: joiners and marks shape the text and stay; bidi controls go; controls and space runs are one space.
    expect(titleIn('<title>\u{1F468}\u200D\u{1F469}\u200D\u{1F467} Family plan</title>')).toBe(
      '\u{1F468}\u200D\u{1F469}\u200D\u{1F467} Family plan',
    );
    expect(titleIn('<title>\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645</title>')).toBe(
      '\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645',
    );
    expect(titleIn('<title>a\u202Eb\u2066c</title>')).toBe('abc');
    expect(titleIn('<title>a\u0007\n\t  b</title>')).toBe('a b');
    // 5, 6: a quote opens a value only where a value starts.
    expect(titleIn("<img alt=Don't src=x.png><title>Real</title>")).toBe('Real');
    expect(titleIn("<a title='x>y'><title>Real</title>")).toBe('Real');
    // 7, 8: nested svg and template are counted; 9: raw text ends at its first closer.
    expect(titleIn('<svg><svg></svg><title>icon</title></svg><title>Real</title>')).toBe('Real');
    expect(titleIn('<template><template></template><title>t</title></template><title>Real</title>')).toBe('Real');
    expect(titleIn('<script>"<script>"</script><title>Real</title>')).toBe('Real');
    // Review: all bidi controls go (LRM, RLM, ALM); nothing visible is no title.
    expect(titleIn('<title>a\u200Eb\u200Fc\u061Cd</title>')).toBe('abcd');
    expect(titleIn('<title>&#x200B;\u2060\u{E0041}</title>')).toBeNull();
    // Review: an unquoted value keeps a quote or an = as text.
    expect(titleIn("<img alt=x='oops><title>Real</title>")).toBe('Real');
    expect(titleIn('<a b=c="x><title>Real</title>')).toBe('Real');
    expect(titleIn('<a b = "x>y"><title>Real</title>')).toBe('Real');
    // Review: inside an svg or template, self-closing tags, comments, CDATA,
    // attribute values and raw text children open and close nothing.
    expect(titleIn('<svg><svg/></svg><title>Real</title>')).toBe('Real');
    expect(titleIn('<svg><!-- </svg> --><title>icon</title></svg><title>Real</title>')).toBe('Real');
    expect(titleIn('<svg><![CDATA[ </svg> ]]><title>icon</title></svg><title>Real</title>')).toBe('Real');
    expect(titleIn('<svg><g data-x="</svg>"><title>icon</title></g></svg><title>Real</title>')).toBe('Real');
    expect(titleIn('<template><script>"</template><title>Fake</title>"</script></template><title>Real</title>')).toBe(
      'Real',
    );
    // Round 2: inside an svg a <style> holds markup, so its </svg> closes the svg.
    expect(titleIn('<svg><style></svg><title>A</title><svg></style></svg><title>B</title>')).toBe('A');
    // In a template, <![CDATA[ is no section: its > ends it.
    expect(titleIn('<template><![CDATA[></template><title>A</title><template>]]></template><title>B</title>')).toBe(
      'A',
    );
    // A value ending in / is not a self-closing tag.
    expect(titleIn('<svg><svg a=/></svg><title>icon</title></svg><title>Real</title>')).toBe('Real');
  });

  it("136: headings drop the folders every prototype folder shares, keeping each one's name", () => {
    const of = (folders: string[]) => [...headingsFor(folders).values()];
    expect(of(['product/prototypes/admin', 'product/prototypes/campaign-owner', 'product/prototypes/clipper'])).toEqual(
      ['admin', 'campaign-owner', 'clipper'],
    );
    expect(of(['product/prototypes/admin'])).toEqual(['admin']);
    expect(of(['a/b', 'a/b/c'])).toEqual(['b', 'b/c']);
    expect(of(['x', 'y/z'])).toEqual(['x', 'y/z']);
    // Whole folder names, never a shared beginning of one.
    expect(of(['p/ab/x', 'p/abc/y'])).toEqual(['ab/x', 'abc/y']);
    expect(of([])).toEqual([]);
  });

  it("136: prototypes only at the docs folder's top: rows, no heading", () => {
    const proto = tempDir();
    put(proto, 'a.html', '<title>A</title>');
    const page = prototypesPage(['a.html'], proto);
    expect(page).toContain('- [A](/a.html)');
    expect(page).not.toMatch(/^## /m);
  });

  it('1, 7: the sidebar ends with Prototypes only when the build lists them', () => {
    const docs = tempDir();
    put(docs, 'index.md', '# Home\n');
    put(docs, 'first.md', '---\norder: 1\n---\n# First\n');
    put(docs, 'zeta.md', '# Zeta\n');
    put(docs, 'prototypes.md', '---\ntitle: Prototypes\n---\n# Prototypes\n');
    const listed = siteShape(docs, 'r', 'index.md', true).themeConfig.sidebar;
    expect(listed.map((i) => i.text)).toEqual(['Home', 'First', 'Zeta', 'Prototypes']);
    expect(listed.at(-1)).toEqual({ text: 'Prototypes', link: '/prototypes' });
    // 9: without prototypes, an author's prototypes.md is an ordinary page.
    const plain = siteShape(docs, 'r', 'index.md', false).themeConfig.sidebar;
    expect(plain.map((i) => i.text)).toEqual(['Home', 'First', 'Prototypes', 'Zeta']);
    expect(plain.find((i) => i.text === 'Prototypes')).toEqual({ text: 'Prototypes', link: '/prototypes' });
  });
});
