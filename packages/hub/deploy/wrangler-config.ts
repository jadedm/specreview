// The wrangler config a deploy uses, generated from the organisation's folder
// and this checkout's own wrangler.jsonc. Paths are absolute so wrangler
// builds this checkout whatever the working directory, and the compatibility
// date and cron come from the pinned commit rather than from the organisation.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { deployable, hubConfig, type Org } from './org';

export const HUB_DIR = path.resolve(import.meta.dirname, '..');

// wrangler.jsonc allows comments and trailing commas; strip both outside
// strings, then parse.
export const parseJsonc = (text: string): unknown => {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const end = (() => {
        let j = i + 1;
        while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
        return j;
      })();
      out += text.slice(i, end + 1);
      i = end;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1;
      continue;
    }
    out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
};

type Pinned = { compatibility_date: string; compatibility_flags?: string[]; triggers: { crons: string[] } };

export const pinned = (hubDir = HUB_DIR): Pinned => {
  const raw = parseJsonc(readFileSync(path.join(hubDir, 'wrangler.jsonc'), 'utf8')) as Partial<Pinned>;
  if (typeof raw.compatibility_date !== 'string' || !Array.isArray(raw.triggers?.crons)) {
    throw new Error('wrangler.jsonc lacks compatibility_date or triggers.crons');
  }
  return {
    compatibility_date: raw.compatibility_date,
    ...(raw.compatibility_flags ? { compatibility_flags: raw.compatibility_flags } : {}),
    triggers: { crons: raw.triggers.crons },
  };
};

export const wranglerConfig = (org: Org, hubDir = HUB_DIR) => {
  const hub = deployable(org.hub);
  const { compatibility_date, compatibility_flags, triggers } = pinned(hubDir);
  return {
    name: hub.worker,
    main: path.join(hubDir, 'src', 'index.ts'),
    compatibility_date,
    ...(compatibility_flags ? { compatibility_flags } : {}),
    account_id: hub.accountId,
    // Only the organisation's hostname, behind Access; no workers.dev address
    // and no per-version preview URLs, which Access would not cover.
    workers_dev: false,
    preview_urls: false,
    routes: [{ pattern: hub.hostname, custom_domain: true }],
    d1_databases: [
      {
        binding: 'DB',
        database_name: hub.database.name,
        database_id: hub.database.id,
        migrations_dir: path.join(hubDir, 'migrations'),
      },
    ],
    r2_buckets: [{ binding: 'SITES', bucket_name: hub.bucket.name }],
    triggers,
    vars: { SPECREVIEW_CONFIG: hubConfig(org) },
  };
};
