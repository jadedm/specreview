// An organisation's folder: specreview.config.json (who reads, who signs off,
// which repos publish) and hub.json (where the hub runs). Each fact lives in
// one file: the Access team domain and audience are written into hub.json by
// setup, and deploy adds them to the config before validating it.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { problemsIn } from '../src/config';

export type HubJson = {
  accountId: string;
  hostname: string;
  worker: string;
  database: { name: string; id?: string };
  bucket: { name: string; created?: boolean };
  access?: { teamDomain?: string; appId?: string; aud?: string; publishAppId?: string };
};

export type Org = {
  dir: string;
  hub: HubJson;
  // specreview.config.json as written, without the Access fields.
  config: Record<string, unknown>;
};

export class DeployError extends Error {}

const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
// Wrangler's Worker names: lowercase letters, digits and dashes, up to 63.
const WORKER = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const D1_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
// R2 bucket names: 3 to 63 lowercase letters, digits and dashes.
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const HUB_KEYS = new Set(['$schema', 'accountId', 'hostname', 'worker', 'database', 'bucket', 'access']);
const ACCESS_KEYS = new Set(['teamDomain', 'appId', 'aud', 'publishAppId']);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

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
  for (const key of ['accessTeamDomain', 'accessAud']) {
    if (isObject(config) && key in config) problems.push(`specreview.config.json sets ${key}; it belongs in hub.json`);
  }
  if (problems.length > 0) throw new DeployError(`the organisation folder has problems:\n  ${problems.join('\n  ')}`);
  return { dir, hub: hub as HubJson, config: config as Record<string, unknown> };
};

// setup records each resource as soon as it exists, so a failed run resumes.
export const saveHub = (org: Org) => {
  writeFileSync(path.join(org.dir, 'hub.json'), `${JSON.stringify(org.hub, null, 2)}\n`);
};

// What setup must have recorded before the hub can be deployed.
export const deployable = (hub: HubJson) => {
  const missing = [
    !hub.database.id && 'database.id',
    !hub.bucket.created && 'bucket.created',
    !hub.access?.teamDomain && 'access.teamDomain',
    !hub.access?.aud && 'access.aud',
    !hub.access?.appId && 'access.appId',
    !hub.access?.publishAppId && 'access.publishAppId',
  ].filter(Boolean);
  if (missing.length > 0) throw new DeployError(`run setup with --apply first; hub.json lacks ${missing.join(', ')}`);
  return hub as HubJson & {
    database: { id: string };
    access: { teamDomain: string; aud: string; appId: string; publishAppId: string };
  };
};

// The config the Worker runs with: the organisation's file plus the Access
// fields from hub.json, validated exactly as the Worker validates it.
export const hubConfig = (org: Org): string => {
  const hub = deployable(org.hub);
  const merged = { ...org.config, accessTeamDomain: hub.access.teamDomain, accessAud: hub.access.aud };
  const problems = problemsIn(merged);
  if (problems.length > 0) throw new DeployError(`specreview.config.json has problems:\n  ${problems.join('\n  ')}`);
  return JSON.stringify(merged);
};
