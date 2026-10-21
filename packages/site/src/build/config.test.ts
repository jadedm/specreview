import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMarkdownRenderer } from 'vitepress';
import { afterAll, describe, expect, it } from 'vitest';
import { forbiddenIn } from './checks.js';
import { siteConfig } from './config.js';

const docs = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'site-config-')));
afterAll(() => rmSync(docs, { recursive: true, force: true }));

describe("the site's markdown options", () => {
  it('VitePress reads no file for a snippet import: the rule is off', async () => {
    writeFileSync(path.join(docs, 'index.md'), '# Home\n');
    writeFileSync(path.join(docs, 'other.txt'), 'CONTENT FROM ANOTHER FILE\n');
    const { markdown } = siteConfig({ repo: 'fixture', docs, root: docs, docsRel: '', out: docs, vpRoot: docs });
    const md = await createMarkdownRenderer(docs, markdown, '/fixture/');
    const env = { path: path.join(docs, 'index.md'), relativePath: 'index.md' };
    for (const line of [`<<< ${path.join(docs, 'other.txt')}`, '<<< @/other.txt', '<<<./other.txt']) {
      const html = md.render(`# Home\n\n${line}\n`, env);
      expect(html, line).not.toContain('CONTENT FROM ANOTHER FILE');
      expect(html, line).toContain('&lt;&lt;&lt;');
    }
  });

  // The check parses with this package's markdown-it; VitePress bundles its own.
  it('the page check finds code where VitePress renders code, at any nesting', async () => {
    const { markdown } = siteConfig({ repo: 'fixture', docs, root: docs, docsRel: '', out: docs, vpRoot: docs });
    const md = await createMarkdownRenderer(docs, markdown, '/fixture/');
    const env = { path: path.join(docs, 'index.md'), relativePath: 'index.md' };
    const pages = [
      '    <script>',
      '\t<script>',
      '-     <script>',
      '- x\n      <script>',
      '>     <script>',
      '> x\n>     <script>',
      '::: tip\n    <script>\n:::',
      '::: tip\n```\n:::\n<script>',
      '::: details T\n- x\n\n      <script>\n:::',
      '> [!NOTE]\n>     <script>',
      '- x\n\n      <script>',
      '1. x\n\n       <script>',
      '    ```\n<script>',
      '   ```\n<script>\n   ```',
      '````\n```\n<script>\n```\n````',
      '~~~\n<script>\n```',
    ];
    for (const page of pages) {
      const inCode = [...md.render(page, env).matchAll(/<pre\b[\s\S]*?<\/pre>/g)].some((m) =>
        m[0].includes('&lt;script&gt;'),
      );
      expect(forbiddenIn(page) === null, page).toBe(inCode);
    }
  });
});
