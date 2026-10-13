// The organisation's logo (#33): a PNG or WebP file beside its
// specreview.config.json, named by `brand.logo`. deploy stores it in the
// hub's bucket under a key made from its bytes, so a new logo never replaces
// the file a running Worker points at; the Worker's config names the key.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { DeployError, type Org } from './org';

export const MAX_LOGO_BYTES = 256 * 1024;

// `bytes` are the checked bytes: the key is their hash and they are what is
// uploaded, so the file is read once however long deploy takes.
export type Logo = { file: string; key: string; type: 'image/png' | 'image/webp'; bytes: Buffer };

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(png|webp)$/;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const ascii = (bytes: Buffer, at: number, text: string) =>
  bytes.subarray(at, at + text.length).toString('latin1') === text;
// Checked by the bytes, not the name: SVG or HTML renamed .png is refused.
const SIGNATURE: Record<string, (b: Buffer) => boolean> = {
  png: (b) => PNG.every((byte, i) => b[i] === byte),
  webp: (b) => ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP'),
};
const TYPE = { png: 'image/png', webp: 'image/webp' } as const;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const logoOf = (org: Org): Logo | null => {
  const brand = org.config.brand;
  if (!isObject(brand) || brand.logo === undefined) return null;
  const name = brand.logo;
  const ext = typeof name === 'string' ? FILE_NAME.exec(name)?.[1] : undefined;
  if (!ext) throw new DeployError('brand.logo must be a .png or .webp file name in the organisation folder');
  const file = path.join(org.dir, name as string);
  if (!existsSync(file) || !statSync(file).isFile()) throw new DeployError(`brand.logo: ${name as string} is missing`);
  if (statSync(file).size > MAX_LOGO_BYTES) throw new DeployError(`brand.logo: ${name as string} is over 256 KB`);
  const bytes = readFileSync(file);
  if (!SIGNATURE[ext](bytes)) throw new DeployError(`brand.logo: ${name as string} is not a ${ext.toUpperCase()} file`);
  const digest = createHash('sha256').update(bytes).digest('hex');
  return { file, key: `_brand/logo-${digest}.${ext}`, type: TYPE[ext as keyof typeof TYPE], bytes };
};

// The Worker's form of the brand: the logo as its stored key and type.
// `logo` is the one already read, when the caller has it.
export const workerBrand = (org: Org, logo: Logo | null = logoOf(org)): unknown => {
  const brand = org.config.brand;
  if (!isObject(brand)) return brand;
  const { logo: _file, ...rest } = brand;
  return logo ? { ...rest, logo: { key: logo.key, type: logo.type } } : rest;
};
