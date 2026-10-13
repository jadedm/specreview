// #33: the organisation's logo through deploy. Case numbers are the ticket's.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { logoOf, MAX_LOGO_BYTES } from './brand';
import { deploy, type Run } from './deploy';
import { loadOrg } from './org';
import { HUB_DIR, wranglerConfig } from './wrangler-config';
import { CONFIG, orgDir } from './test-helpers';

// examples/org is the blank template (#55); this is the same org after setup.
const exampleHub = () =>
  JSON.parse(readFileSync(path.join(HUB_DIR, 'deploy', 'fixtures', 'finished-hub.json'), 'utf8')) as Record<
    string,
    unknown
  >;

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png body')]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([8, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const KEY = /^_brand\/logo-[0-9a-f]{64}\.png$/;

// An organisation folder with a brand and, optionally, a logo file in it.
const brandedOrg = (brand: unknown, files: Record<string, Buffer | string> = {}, hub = exampleHub()) => {
  const { dir, tokenFile } = orgDir(hub, { ...CONFIG, brand });
  for (const [name, bytes] of Object.entries(files)) writeFileSync(path.join(dir, name), bytes);
  return { dir, tokenFile };
};
// Wrangler calls by their first words; `codes` answers them in order.
const recorder = (codes: Record<string, number> = {}) => {
  const calls: string[][] = [];
  const run: Run = async (args) => {
    calls.push(args);
    return codes[args.slice(0, 3).join(' ')] ?? codes[args[0]] ?? 0;
  };
  return { run, calls };
};
const noWait = async () => 'resolver' as const;
const workerConfig = (dir: string) =>
  JSON.parse(wranglerConfig(loadOrg(dir)).vars.SPECREVIEW_CONFIG) as { brand?: { name: string; logo?: unknown } };
const hubJson = (dir: string) => JSON.parse(readFileSync(path.join(dir, 'hub.json'), 'utf8')) as { brand?: unknown };

describe('33: the logo file', () => {
  it('1: a valid PNG and WebP become a content key and type in the Worker config', () => {
    for (const [file, bytes, type] of [
      ['logo.png', PNG, 'image/png'],
      ['logo.webp', WEBP, 'image/webp'],
    ] as const) {
      const { dir } = brandedOrg({ name: 'Acme', logo: file }, { [file]: bytes });
      const brand = workerConfig(dir).brand;
      expect(brand?.name).toBe('Acme');
      expect(brand?.logo).toEqual({ key: expect.stringMatching(/^_brand\/logo-[0-9a-f]{64}\.(png|webp)$/), type });
    }
  });

  it('1: name only: no logo in the Worker config', () => {
    const { dir } = brandedOrg({ name: 'Acme' });
    expect(workerConfig(dir).brand).toEqual({ name: 'Acme' });
  });

  it('4: refused before anything runs: SVG, wrong bytes, too big, paths, missing file', () => {
    const cases: [unknown, Record<string, Buffer | string>, RegExp][] = [
      ['logo.svg', { 'logo.svg': '<svg/>' }, /must be a \.png or \.webp file name/],
      ['../logo.png', {}, /must be a \.png or \.webp file name/],
      ['sub/logo.png', {}, /must be a \.png or \.webp file name/],
      ['.logo.png', {}, /must be a \.png or \.webp file name/],
      [7, {}, /must be a \.png or \.webp file name/],
      ['logo.png', {}, /logo\.png is missing/],
      ['logo.png', { 'logo.png': '<svg onload=alert(1)/>' }, /is not a PNG file/],
      ['logo.webp', { 'logo.webp': PNG }, /is not a WEBP file/],
      ['logo.png', { 'logo.png': Buffer.concat([PNG, Buffer.alloc(MAX_LOGO_BYTES)]) }, /over 256 KB/],
    ];
    for (const [logo, files, why] of cases) {
      const { dir } = brandedOrg({ name: 'Acme', logo }, files);
      expect(() => wranglerConfig(loadOrg(dir)), String(logo)).toThrow(why);
    }
  });

  it('3: a bad name is refused by the same rules the Worker uses', () => {
    const { dir } = brandedOrg({ name: 'Acme‮' });
    expect(() => wranglerConfig(loadOrg(dir))).toThrow(/brand\.name must have no control characters/);
  });

  it('20: the same bytes give the same key', () => {
    const a = brandedOrg({ name: 'Acme', logo: 'logo.png' }, { 'logo.png': PNG });
    const b = brandedOrg({ name: 'Acme', logo: 'other.png' }, { 'other.png': PNG });
    expect(logoOf(loadOrg(a.dir))?.key).toBe(logoOf(loadOrg(b.dir))?.key);
  });
});

describe('33: deploy order', () => {
  const run = (dir: string, tokenFile: string, r: ReturnType<typeof recorder>, lines: string[] = []) =>
    deploy({ org: loadOrg(dir), tokenFile, run: r.run, log: (l) => lines.push(l), dryRun: false, wait: noWait });

  it('1: the logo is uploaded first, then migrations and the Worker; hub.json records the key', async () => {
    const { dir, tokenFile } = brandedOrg({ name: 'Acme', logo: 'logo.png' }, { 'logo.png': PNG });
    const r = recorder();
    await run(dir, tokenFile, r);
    expect(r.calls.map((c) => c.slice(0, 3).join(' '))).toEqual([
      'r2 object put',
      'd1 migrations apply',
      'deploy --config ' + r.calls[2][2],
    ]);
    const put = r.calls[0];
    expect(put[3]).toMatch(new RegExp(`^specreview-sites/_brand/logo-[0-9a-f]{64}\\.png$`));
    expect(put).toEqual(expect.arrayContaining(['--content-type', 'image/png', '--remote']));
    expect(hubJson(dir).brand).toEqual({ logoKey: put[3].slice('specreview-sites/'.length) });
  });

  it('dry run: the logo is checked, nothing is uploaded or recorded', async () => {
    const { dir, tokenFile } = brandedOrg({ name: 'Acme', logo: 'logo.png' }, { 'logo.png': PNG });
    const before = readFileSync(path.join(dir, 'hub.json'), 'utf8');
    const calls: string[][] = [];
    await deploy({ org: loadOrg(dir), tokenFile, run: async (a) => (calls.push(a), 0), log: () => {}, dryRun: true });
    expect(calls.map((c) => c[0])).toEqual(['deploy']);
    expect(readFileSync(path.join(dir, 'hub.json'), 'utf8')).toBe(before);
    writeFileSync(path.join(dir, 'logo.png'), '<svg/>');
    await expect(
      deploy({ org: loadOrg(dir), tokenFile, run: async () => 0, log: () => {}, dryRun: true }),
    ).rejects.toThrow(/not a PNG file/);
  });

  it('review: a failed wait keeps the old logo, records the live one, and the next deploy deletes the old', async () => {
    const old = `_brand/logo-${'c'.repeat(64)}.png`;
    const { dir, tokenFile } = brandedOrg(
      { name: 'Acme', logo: 'logo.png' },
      { 'logo.png': PNG },
      { ...exampleHub(), brand: { logoKey: old } },
    );
    const r = recorder();
    const failingWait = async (): Promise<'resolver'> => {
      throw new Error('did not answer');
    };
    await expect(
      deploy({ org: loadOrg(dir), tokenFile, run: r.run, log: () => {}, dryRun: false, wait: failingWait }),
    ).rejects.toThrow(/did not answer/);
    expect(r.calls.some((c) => c[2] === 'delete')).toBe(false);
    const after = hubJson(dir).brand as { logoKey: string; keys: string[] };
    expect(after.logoKey).toMatch(KEY);
    expect(after.keys).toContain(old);
    const next = recorder();
    await run(dir, tokenFile, next);
    expect(next.calls.filter((c) => c[2] === 'delete').map((c) => c[3])).toEqual([`specreview-sites/${old}`]);
    expect(hubJson(dir).brand).toEqual({ logoKey: after.logoKey });
  });

  it('review: the logo is read once: the checked bytes are uploaded and the Worker names their key', async () => {
    const { dir, tokenFile } = brandedOrg({ name: 'Acme', logo: 'logo.png' }, { 'logo.png': PNG });
    let uploaded: Buffer | null = null;
    let uploadedKey = '';
    let namedKey = '';
    const run: Run = async (args) => {
      if (args[2] === 'put') {
        // The file changes on disk mid-deploy.
        writeFileSync(path.join(dir, 'logo.png'), '<svg onload=alert(1)/>');
        uploaded = readFileSync(args[args.indexOf('--file') + 1]);
        uploadedKey = args[3].slice('specreview-sites/'.length);
      }
      if (args[0] === 'deploy') {
        const cfg = JSON.parse(readFileSync(args[args.indexOf('--config') + 1], 'utf8')) as {
          vars: { SPECREVIEW_CONFIG: string };
        };
        namedKey = (JSON.parse(cfg.vars.SPECREVIEW_CONFIG) as { brand: { logo: { key: string } } }).brand.logo.key;
      }
      return 0;
    };
    await deploy({ org: loadOrg(dir), tokenFile, run, log: () => {}, dryRun: false, wait: noWait });
    expect(uploaded).toEqual(PNG);
    expect(namedKey).toBe(uploadedKey);
    expect(hubJson(dir).brand).toEqual({ logoKey: uploadedKey });
  });

  it('16: a failed upload deploys nothing and leaves hub.json alone', async () => {
    const { dir, tokenFile } = brandedOrg({ name: 'Acme', logo: 'logo.png' }, { 'logo.png': PNG });
    const before = readFileSync(path.join(dir, 'hub.json'), 'utf8');
    const r = recorder({ 'r2 object put': 1 });
    await expect(run(dir, tokenFile, r)).rejects.toThrow(/uploading the logo failed/);
    expect(r.calls).toHaveLength(1);
    expect(readFileSync(path.join(dir, 'hub.json'), 'utf8')).toBe(before);
  });

  it('17: a failed Worker deploy keeps the old logo and its record', async () => {
    const old = `_brand/logo-${'c'.repeat(64)}.png`;
    const { dir, tokenFile } = brandedOrg(
      { name: 'Acme', logo: 'logo.png' },
      { 'logo.png': PNG },
      { ...exampleHub(), brand: { logoKey: old } },
    );
    const r = recorder({ deploy: 1 });
    await expect(run(dir, tokenFile, r)).rejects.toThrow(/wrangler deploy failed/);
    expect(r.calls.some((c) => c[2] === 'delete')).toBe(false);
    // The old Worker still names the old key; the uploaded one is recorded, to delete later.
    const after = hubJson(dir).brand as { logoKey: string; keys: string[] };
    expect(after.logoKey).toBe(old);
    expect(after.keys).toEqual([expect.stringMatching(KEY)]);
  });

  it('19: a new logo replaces the old one: the old key is deleted only after the deploy', async () => {
    const old = `_brand/logo-${'c'.repeat(64)}.png`;
    const { dir, tokenFile } = brandedOrg(
      { name: 'Acme', logo: 'logo.webp' },
      { 'logo.webp': WEBP },
      { ...exampleHub(), brand: { logoKey: old } },
    );
    const r = recorder();
    await run(dir, tokenFile, r);
    const order = r.calls.map((c) => c.slice(0, 3).join(' '));
    expect(order.indexOf('r2 object delete')).toBeGreaterThan(order.findIndex((c) => c.startsWith('deploy')));
    expect(r.calls.find((c) => c[2] === 'delete')?.[3]).toBe(`specreview-sites/${old}`);
    expect((hubJson(dir).brand as { logoKey: string }).logoKey).toMatch(/\.webp$/);
  });

  it('5: removing brand.logo deletes the old logo and its record', async () => {
    const old = `_brand/logo-${'c'.repeat(64)}.png`;
    const { dir, tokenFile } = brandedOrg({ name: 'Acme' }, {}, { ...exampleHub(), brand: { logoKey: old } });
    const r = recorder();
    await run(dir, tokenFile, r);
    expect(r.calls.some((c) => c[2] === 'put')).toBe(false);
    expect(r.calls.find((c) => c[2] === 'delete')?.[3]).toBe(`specreview-sites/${old}`);
    expect(hubJson(dir).brand).toBeUndefined();
  });

  it('20: the same logo again deletes nothing', async () => {
    const { dir, tokenFile } = brandedOrg({ name: 'Acme', logo: 'logo.png' }, { 'logo.png': PNG });
    await run(dir, tokenFile, recorder());
    const r = recorder();
    await run(dir, tokenFile, r);
    expect(r.calls.some((c) => c[2] === 'delete')).toBe(false);
    expect((hubJson(dir).brand as { logoKey: string }).logoKey).toMatch(KEY);
  });

  it('18: a failed delete after a good deploy is a warning naming the leftover key', async () => {
    const old = `_brand/logo-${'c'.repeat(64)}.png`;
    const { dir, tokenFile } = brandedOrg(
      { name: 'Acme', logo: 'logo.png' },
      { 'logo.png': PNG },
      { ...exampleHub(), brand: { logoKey: old } },
    );
    const lines: string[] = [];
    await run(dir, tokenFile, recorder({ 'r2 object delete': 1 }), lines);
    expect(lines.some((l) => l.startsWith('warning:') && l.includes(old))).toBe(true);
    const after = hubJson(dir).brand as { logoKey: string; keys: string[] };
    expect(after.logoKey).toMatch(KEY);
    // Still recorded, so the next deploy tries again.
    expect(after.keys).toEqual([old]);
  });

  it('hub.json brand holds only a logo key', async () => {
    const { dir } = brandedOrg({ name: 'Acme' }, {}, { ...exampleHub(), brand: { logoKey: 'logo.png' } });
    expect(() => loadOrg(dir)).toThrow(/hub.json brand is written by deploy/);
  });
});
