import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createMarkdownRenderer } from 'vitepress';
import { describe, expect, it } from 'vitest';
import { noInterpolation } from './config.js';
import { escapeHtml, sanitizeRendered } from './sanitize.js';

// VitePress's own renderer, configured as the build configures it.
const renderer = async () => {
  const md = await createMarkdownRenderer('/tmp', { html: false, attrs: { disable: true } }, '/fixture/');
  return { raw: md.render.bind(md), md: (noInterpolation(md), md) };
};
const tagsOf = (html: string) => [...html.matchAll(/<([a-zA-Z0-9-]+)/g)].map((m) => m[1]);
const attrsOf = (html: string) =>
  [...html.matchAll(/<([a-zA-Z0-9-]+)([^>]*)>/g)].map((m) =>
    [...m[2].matchAll(/([^\s=]+)(?:="[^"]*")?/g)]
      .map((a) => a[1])
      .filter((name) => name !== '/')
      .sort()
      .join(' '),
  );

describe('the sanitizer keeps what VitePress writes for plain Markdown', () => {
  it('every element of every feature survives', async () => {
    const { raw } = await renderer();
    const source = readFileSync(path.join(import.meta.dirname, '..', '..', 'test', 'features.md'), 'utf8');
    const html = raw(source, {});
    const clean = sanitizeRendered(html);
    expect(tagsOf(clean)).toEqual(tagsOf(html));
    // And every attribute, by name, on every element, except two VitePress
    // adds that nothing needs: aria-hidden on line numbers, v-pre on ::: v-pre.
    expect(attrsOf(clean)).toEqual(attrsOf(html));
    for (const kept of ['v-pre', '--shiki-light', 'text-align:center', 'type="radio"', 'class="tip custom-block"']) {
      expect(clean, kept).toContain(kept);
    }
  });
});

describe('page text that would reach Vue or HTML through a plugin', () => {
  const hostile: [string, string][] = [
    ['code-group title', '::: code-group\n```sh [{{ 6*7 }}<form action=x><input name=pw></form>]\nx\n```\n:::'],
    ['alert title', '> [!TIP] {{ 3*3 }} <form><input></form>\n> body'],
    ['code language', '```{{6*7}}\nx\n```'],
    ['container title', '::: tip {{ 6*7 }}\nbody\n:::'],
    ['table of contents', '[[toc]]\n\n## {{ 6*7 }}'],
    ['indented code', 'text\n\n    {{ 6*7 }}'],
    ['heading', '## {{ 6*7 }} heading'],
    ['link and image text', '[{{ 6*7 }}](./x "{{ 6*7 }}") ![{{ 6*7 }}](./i.png "{{ 6*7 }}")'],
    ['javascript and data links', '[a](javascript:alert(1)) [b](data:text/html,x) ![c](javascript:alert(1))'],
  ];
  it.each(hostile)('%s: no interpolation, directive, form or script URL survives', async (_name, source) => {
    const { md } = await renderer();
    const html = md.render(source, {});
    // Vue interpolates text, never attribute values.
    expect(html.replace(/<[^>]*>/g, '')).not.toMatch(/\{\{/);
    expect(html).not.toMatch(/<(form|script|style|iframe|object)\b/i);
    const tags = [...html.matchAll(/<[^>]+>/g)].map((m) => m[0]);
    for (const tag of tags) expect(tag).not.toMatch(/\s(@|:|v-(?!pre)|on[a-z]+=)/i);
    const urls = [...html.matchAll(/\s(?:href|src)="([^"]*)"/g)].map((m) => m[1]);
    for (const url of urls) expect(url).not.toMatch(/^(javascript|data|vbscript):/i);
  });
});

describe('titles VitePress shows with v-html', () => {
  it('are escaped', () => {
    expect(escapeHtml('<form action="x">A & B</form>')).toBe('&lt;form action=&quot;x&quot;&gt;A &amp; B&lt;/form&gt;');
  });
});
