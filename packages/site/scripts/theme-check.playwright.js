// Browser smoke for the theme (#32), run with the Playwright MCP browser_run_code
// tool (filename: packages/site/scripts/theme-check.playwright.js) against the hub
// smoke server. Reports, per page and state: non-grey colours, text below WCAG AA
// contrast, web font requests, and focusable controls without a solid 2px ring.
// The file is one function expression, as that tool expects, so ESLint skips it.
async (page) => {
  const HUB = 'http://127.0.0.1:8796';
  const PAGES = ['/sidecar/', '/sidecar/features', '/sidecar/guide/', '/sidecar/alerts'];
  const fonts = [];
  page.on('request', (r) => { if (/\.(woff2?|ttf|otf)(\?|$)/.test(r.url())) fonts.push(r.url()); });

  const inspect = () => {
    const parse = (s) => {
      const m = s && s.match(/rgba?\(([^)]+)\)/g);
      return (m || []).map((x) => {
        const p = x.replace(/rgba?\(|\)/g, '').split(/[ ,/]+/).filter(Boolean).map(Number);
        return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
      });
    };
    const chroma = (c) => c.a > 0 && Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) > 2;
    const name = (el) => {
      const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
      return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls ? '.' + cls : ''}`;
    };
    const offenders = {};
    const note = (key, value) => { offenders[key] = offenders[key] || value; };
    let checked = 0;
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    for (const el of document.querySelectorAll('body *')) {
      if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(el.tagName) || !visible(el)) continue;
      checked++;
      for (const pseudo of [null, '::before', '::after', '::marker', '::selection']) {
        const cs = getComputedStyle(el, pseudo);
        if ((pseudo === '::before' || pseudo === '::after') && (cs.content === 'none' || cs.content === 'normal')) continue;
        const props = ['color', 'background-color', 'fill', 'stroke', 'box-shadow', 'background-image', 'caret-color', 'accent-color', 'scrollbar-color', 'mask-image', '-webkit-mask-image'];
        for (const side of ['top', 'right', 'bottom', 'left'])
          if (parseFloat(cs.getPropertyValue(`border-${side}-width`)) > 0 && cs.getPropertyValue(`border-${side}-style`) !== 'none')
            props.push(`border-${side}-color`);
        if (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) props.push('outline-color');
        if (cs.textDecorationLine && cs.textDecorationLine !== 'none') props.push('text-decoration-color');
        if (pseudo === '::marker' && el.tagName !== 'LI') continue;
        for (const prop of props) {
          const v = cs.getPropertyValue(prop);
          if (parse(v).some(chroma)) note(`${name(el)}${pseudo || ''} ${prop}`, v);
        }
      }
    }
    // Contrast of text against the first opaque background up the tree.
    const lum = ({ r, g, b }) => {
      const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const bgOf = (el) => {
      for (let at = el; at; at = at.parentElement) {
        const c = parse(getComputedStyle(at).backgroundColor)[0];
        if (c && c.a >= 0.99) return c;
      }
      return { r: 255, g: 255, b: 255, a: 1 };
    };
    const contrast = [];
    let texts = 0;
    for (const el of document.querySelectorAll('body *')) {
      if (!visible(el) || el.closest('[aria-hidden="true"], .rv-sr, [disabled]')) continue;
      // Text a reader can see: not only zero-width characters, not faded out.
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.replace(/[\u200b-\u200d\ufeff]/g, '').trim());
      if (!own) continue;
      let shown = 1;
      for (let at = el; at; at = at.parentElement) shown *= Number(getComputedStyle(at).opacity);
      if (shown < 0.1) continue;
      texts++;
      const cs = getComputedStyle(el);
      const fg = parse(cs.color)[0];
      if (!fg || fg.a === 0) continue;
      const bg = bgOf(el);
      let alpha = fg.a;
      for (let at = el; at; at = at.parentElement) alpha *= Number(getComputedStyle(at).opacity);
      const mix = (f, b) => Math.round(f * alpha + b * (1 - alpha));
      const eff = { r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b) };
      const L1 = lum(eff), L2 = lum(bg);
      const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      const size = parseFloat(cs.fontSize), bold = Number(cs.fontWeight) >= 700;
      const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
      if (ratio < need) contrast.push(`${name(el)} "${el.textContent.trim().slice(0, 30)}" ${ratio.toFixed(2)} < ${need}`);
    }
    return {
      checked,
      texts,
      resolvedThreads: document.querySelectorAll('.rv-thread[data-state="resolved"]').length,
      panel: !!document.querySelector('#rv-mount-top .rv-status'),
      font: getComputedStyle(document.body).fontFamily.slice(0, 60),
      offenders,
      contrast: [...new Set(contrast)],
    };
  };

  await page.goto(`${HUB}/__smoke/login?email=dev@acme.dev`);
  // A resolved thread on the features page, so its styles are inspected too.
  await page.goto(`${HUB}/sidecar/features`);
  await page.evaluate(async () => {
    const pages = await (await fetch('/sidecar/_api/pages')).json();
    const section = pages.pages.features.sections.find((s) => s.text.length > 10);
    if (!section) throw new Error('theme check setup: no section with text on the features page');
    // Fails closed: a setup request that does not succeed stops the run.
    const post = async (url, body) => {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`theme check setup: POST ${url} answered ${r.status}`);
      return r.json();
    };
    const made = await post('/sidecar/_api/comments', { page: 'features', heading: section.id, quote: section.text.slice(0, 12), body: 'A resolved thread.' });
    await post(`/sidecar/_api/comments/${made.id}/resolve`, {});
  });
  const out = {};
  const run = async (label, prep) => {
    if (prep) await prep();
    const r = await page.evaluate(inspect);
    out[label] = { ...r, offenderCount: Object.keys(r.offenders).length };
  };
  const open = async (p) => {
    await page.goto(HUB + p);
    // Fails closed: a page whose review panel never mounts stops the run.
    await page.waitForSelector('#rv-mount-top .rv-status', { timeout: 15000 });
    await page.waitForTimeout(300);
  };
  await page.setViewportSize({ width: 1280, height: 900 });
  for (const p of PAGES) await run(p, () => open(p));
  await run('features, code hovered', async () => { await open('/sidecar/features'); await page.hover('div[class*="language-"]'); await page.waitForTimeout(800); });
  await run('features, text selected', async () => {
    await page.evaluate(() => { const p = document.querySelector('.vp-doc p'); const r = document.createRange(); r.selectNodeContents(p); getSelection().removeAllRanges(); getSelection().addRange(r); });
  });
  await run('404', async () => { await page.goto(HUB + '/sidecar/no-such-page'); await page.waitForTimeout(500); });
  await page.setViewportSize({ width: 390, height: 844 });
  await run('390px, menu open', async () => {
    await open('/sidecar/features');
    const menu = page.locator('button.menu, .VPLocalNav button, button[aria-label*="menu" i]').first();
    if (await menu.count()) { await menu.click(); await page.waitForTimeout(300); }
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  // Keyboard sweep: every focusable control shows a solid ring of 2px or more.
  await open('/sidecar/features');
  const rings = [];
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press('Tab');
    const f = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      return { name: `${el.tagName.toLowerCase()}.${(el.className && el.className.baseVal === undefined ? el.className : '').split(' ')[0]} "${(el.textContent || '').trim().slice(0, 20)}"`,
        ok: cs.outlineStyle === 'solid' && parseFloat(cs.outlineWidth) >= 2, outline: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}` };
    });
    if (f) rings.push(f);
  }
  out.focus = { tabbed: rings.length, missing: [...new Set(rings.filter((r) => !r.ok).map((r) => `${r.name} ${r.outline}`))] };
  const summary = { fontRequests: [...new Set(fonts)].map((u) => u.split('/').pop()), focus: out.focus };
  delete out.focus;
  for (const [k, v] of Object.entries(out))
    summary[k] = { panel: v.panel, resolvedThreads: v.resolvedThreads, checked: v.checked, texts: v.texts, font: v.font,
      offenderCount: v.offenderCount, offenders: Object.entries(v.offenders).slice(0, 12).map(([a, b]) => `${a}: ${b.slice(0, 40)}`),
      contrastCount: v.contrast.length, contrast: v.contrast.slice(0, 6) };
  return summary;
}
