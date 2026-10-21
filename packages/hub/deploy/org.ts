// An organisation's folder: specreview.config.json (who reads, who signs off,
// which repos publish) and hub.json (where the hub runs). Each fact lives in
// one file: the Access team domain and audience are written into hub.json by
// setup, and deploy adds them to the config before validating it.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { LOGO_KEY, problemsIn } from '../src/config';
import { type Logo, workerBrand } from './brand';

export type HubJson = {
  accountId: string;
  hostname: string;
  // The admin page's own hostname (#75); without it the hub has no admin page.
  adminHostname?: string;
  // The prototypes' own hostname (#116, epic #110); without it the hub serves none.
  protoHostname?: string;
  worker: string;
  database: { name: string; id?: string };
  bucket: { name: string; created?: boolean };
  access?: {
    teamDomain?: string;
    policyId?: string;
    appId?: string;
    aud?: string;
    publishPolicyId?: string;
    publishAppId?: string;
    // While any site is public (#20): the bypass for those sites' pages.
    publicPolicyId?: string;
    publicAppId?: string;
    // With adminHostname (#75): admins only, on the admin hostname.
    adminPolicyId?: string;
    adminAppId?: string;
    adminAud?: string;
    // With protoHostname (#116): the site's readers, on the prototype hostname.
    protoPolicyId?: string;
    protoAppId?: string;
    protoAud?: string;
  };
  // Written by deploy: the logo key the live Worker uses, and every logo key
  // uploaded and not yet deleted, so no stored logo is ever lost track of.
  brand?: { logoKey?: string; keys?: string[] };
  // Written by deploy (#177): the specreview commit the live Worker runs, and
  // the one it ran before an upgrade, which the hub keeps accepting publishes
  // from so product repos keep publishing until their pin moves.
  deployedCommit?: string;
  previousCommit?: string;
};

export type Org = {
  dir: string;
  hub: HubJson;
  // specreview.config.json as written, without the Access fields.
  config: Record<string, unknown>;
  // specreview.commit when it names a real commit (#57); null for a missing
  // file or the template's all-zero placeholder.
  commit: string | null;
};

const COMMIT = /^[0-9a-f]{40}$/;
const commitOf = (dir: string) => {
  const file = path.join(dir, 'specreview.commit');
  if (!existsSync(file)) return null;
  const commit = readFileSync(file, 'utf8').trim();
  return COMMIT.test(commit) && !/^0+$/.test(commit) ? commit : null;
};

// The commit the hub keeps accepting publishes from besides its own (#177):
// the one deployed before when this deploy changes it, else the one already
// kept. Null without a commit to run, or when the kept one is this one.
export const previousCommitOf = (org: Org) => {
  if (!org.commit) return null;
  const { deployedCommit, previousCommit } = org.hub;
  if (deployedCommit && deployedCommit !== org.commit) return deployedCommit;
  return previousCommit && previousCommit !== org.commit ? previousCommit : null;
};

export class DeployError extends Error {}

const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
// Wrangler's Worker names: lowercase letters, digits and dashes, up to 63.
const WORKER = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const D1_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
// R2 bucket names: 3 to 63 lowercase letters, digits and dashes.
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const HUB_KEYS = new Set([
  '$schema',
  'accountId',
  'hostname',
  'adminHostname',
  'protoHostname',
  'worker',
  'database',
  'bucket',
  'access',
  'brand',
  'deployedCommit',
  'previousCommit',
]);
const ACCESS_KEYS = new Set([
  'teamDomain',
  'policyId',
  'appId',
  'aud',
  'publishPolicyId',
  'publishAppId',
  'publicPolicyId',
  'publicAppId',
  'adminPolicyId',
  'adminAppId',
  'adminAud',
  'protoPolicyId',
  'protoAppId',
  'protoAud',
]);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const isLogoKey = (v: unknown) => typeof v === 'string' && LOGO_KEY.test(v);
const brandRecordOk = (brand: unknown) => {
  if (brand === undefined) return true;
  if (!isObject(brand) || !Object.keys(brand).every((k) => k === 'logoKey' || k === 'keys')) return false;
  const keysOk = brand.keys === undefined || (Array.isArray(brand.keys) && brand.keys.every(isLogoKey));
  return keysOk && (brand.logoKey === undefined || isLogoKey(brand.logoKey));
};

export const hubProblems = (raw: unknown): string[] => {
  if (!isObject(raw)) return ['hub.json is not a JSON object'];
  const problems: string[] = [];
  for (const key of Object.keys(raw)) if (!HUB_KEYS.has(key)) problems.push(`hub.json has unknown key ${key}`);
  if (typeof raw.accountId !== 'string' || !ACCOUNT_ID.test(raw.accountId)) {
    problems.push('hub.json accountId must be the 32-character Cloudflare account id');
  }
  if (typeof raw.hostname !== 'string' || !HOSTNAME.test(raw.hostname)) {
    problems.push('hub.json hostname must be a bare lowercase hostname (no scheme, port or path)');
  }
  if (raw.adminHostname !== undefined && (typeof raw.adminHostname !== 'string' || !HOSTNAME.test(raw.adminHostname)))
    problems.push('hub.json adminHostname must be a bare lowercase hostname (no scheme, port or path)');
  if (raw.adminHostname !== undefined && raw.adminHostname === raw.hostname)
    problems.push('hub.json adminHostname must differ from hostname');
  if (raw.protoHostname !== undefined && (typeof raw.protoHostname !== 'string' || !HOSTNAME.test(raw.protoHostname)))
    problems.push('hub.json protoHostname must be a bare lowercase hostname (no scheme, port or path)');
  if (raw.protoHostname !== undefined && [raw.hostname, raw.adminHostname].includes(raw.protoHostname))
    problems.push('hub.json protoHostname must differ from hostname and adminHostname');
  if (typeof raw.worker !== 'string' || !WORKER.test(raw.worker)) {
    problems.push('hub.json worker must be a Worker name: lowercase letters, digits and dashes');
  }
  const db = raw.database;
  if (!isObject(db) || typeof db.name !== 'string' || !D1_NAME.test(db.name)) {
    problems.push('hub.json database.name must be a D1 database name');
  }
  if (isObject(db) && db.id !== undefined && (typeof db.id !== 'string' || !/^[0-9a-f-]{36}$/.test(db.id))) {
    problems.push('hub.json database.id must be a D1 database id');
  }
  const bucket = raw.bucket;
  if (!isObject(bucket) || typeof bucket.name !== 'string' || !BUCKET.test(bucket.name)) {
    problems.push('hub.json bucket.name must be an R2 bucket name');
  }
  if (isObject(bucket) && bucket.created !== undefined && bucket.created !== true) {
    problems.push('hub.json bucket.created is written by setup and may only be true');
  }
  if (raw.access !== undefined && !isObject(raw.access)) problems.push('hub.json access must be an object');
  if (!brandRecordOk(raw.brand))
    problems.push('hub.json brand is written by deploy and may only hold logoKey and keys');
  for (const key of ['deployedCommit', 'previousCommit'])
    if (raw[key] !== undefined && (typeof raw[key] !== 'string' || !COMMIT.test(raw[key])))
      problems.push(`hub.json ${key} is written by deploy and must be a full commit`);
  if (isObject(raw.access)) {
    for (const [key, v] of Object.entries(raw.access)) {
      if (!ACCESS_KEYS.has(key)) problems.push(`hub.json access has unknown key ${key}`);
      else if (typeof v !== 'string' || !/^\S{1,200}$/.test(v)) problems.push(`hub.json access.${key} is malformed`);
    }
  }
  return problems;
};

const readJson = (file: string): unknown => {
  if (!existsSync(file)) throw new DeployError(`${file} is missing`);
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch {
    throw new DeployError(`${file} is not valid JSON`);
  }
};

export const loadOrg = (dir: string): Org => {
  const hub = readJson(path.join(dir, 'hub.json'));
  const config = readJson(path.join(dir, 'specreview.config.json'));
  const problems = hubProblems(hub);
  if (!isObject(config)) problems.push('specreview.config.json is not a JSON object');
  // The prototype hostname too (#112): it belongs in hub.json, where setup
  // keeps its Access app (#116).
  for (const key of [
    'accessTeamDomain',
    'accessAud',
    'hostname',
    'adminHostname',
    'accessAdminAud',
    'protoHostname',
    'accessProtoAud',
  ]) {
    if (isObject(config) && key in config) problems.push(`specreview.config.json sets ${key}; it belongs in hub.json`);
  }
  if (problems.length > 0) throw new DeployError(`the organisation folder has problems:\n  ${problems.join('\n  ')}`);
  return { dir, hub: hub as HubJson, config: config as Record<string, unknown>, commit: commitOf(dir) };
};

// setup records each resource as soon as it exists, so a failed run resumes.
// Written beside the file, then renamed over it: hub.json is the only record
// of the ids, so a crash mid-write must not leave half of it.
export const saveHub = (org: Org) => {
  const file = path.join(org.dir, 'hub.json');
  writeFileSync(`${file}.tmp`, `${JSON.stringify(org.hub, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
};

// What setup must have recorded before the hub can be deployed.
export const deployable = (hub: HubJson) => {
  const missing = [
    !hub.database.id && 'database.id',
    !hub.bucket.created && 'bucket.created',
    !hub.access?.teamDomain && 'access.teamDomain',
    !hub.access?.aud && 'access.aud',
    !hub.access?.policyId && 'access.policyId',
    !hub.access?.appId && 'access.appId',
    !hub.access?.publishPolicyId && 'access.publishPolicyId',
    !hub.access?.publishAppId && 'access.publishAppId',
    // Only when the hub has an admin hostname (#75).
    hub.adminHostname && !hub.access?.adminPolicyId && 'access.adminPolicyId',
    hub.adminHostname && !hub.access?.adminAppId && 'access.adminAppId',
    hub.adminHostname && !hub.access?.adminAud && 'access.adminAud',
    // Only when the hub has a prototype hostname (#116).
    hub.protoHostname && !hub.access?.protoPolicyId && 'access.protoPolicyId',
    hub.protoHostname && !hub.access?.protoAppId && 'access.protoAppId',
    hub.protoHostname && !hub.access?.protoAud && 'access.protoAud',
  ].filter(Boolean);
  if (missing.length > 0) throw new DeployError(`run setup with --apply first; hub.json lacks ${missing.join(', ')}`);
  return hub as HubJson & {
    database: { id: string };
    access: { teamDomain: string; aud: string; appId: string; publishAppId: string };
  };
};

// The organisation's file as the Worker reads it: the logo file resolved to
// its stored key, and the Access fields added. setup checks the same shape
// with placeholder Access fields, so both refuse exactly what the Worker would.
export const workerConfigOf = (
  org: Org,
  access: { teamDomain: string; aud: string; adminAud?: string; protoAud?: string },
  logo?: Logo | null,
) => {
  const admin = org.hub.adminHostname
    ? { hostname: org.hub.hostname, adminHostname: org.hub.adminHostname, accessAdminAud: access.adminAud }
    : {};
  const proto = org.hub.protoHostname
    ? { hostname: org.hub.hostname, protoHostname: org.hub.protoHostname, accessProtoAud: access.protoAud }
    : {};
  const merged = {
    ...org.config,
    ...(org.config.brand === undefined ? {} : { brand: workerBrand(org, logo) }),
    accessTeamDomain: access.teamDomain,
    accessAud: access.aud,
    ...admin,
    ...proto,
  };
  const problems = problemsIn(merged);
  if (problems.length > 0) throw new DeployError(`specreview.config.json has problems:\n  ${problems.join('\n  ')}`);
  return merged;
};

// The config the Worker runs with: the Access fields from hub.json.
export const hubConfig = (org: Org, logo?: Logo | null): string =>
  JSON.stringify(workerConfigOf(org, deployable(org.hub).access, logo));
