// The Cloudflare API, as setup and secret use it. The token is read from its
// file at every call and only ever placed in a request header.
import { readFileSync } from 'node:fs';
import { DeployError } from './org';

const API = 'https://api.cloudflare.com/client/v4';
const PER_PAGE = 50;

export type CfError = { code?: number; message?: string };

// Which token permission a call needs (#66), so a token without it is told
// what to add. First match wins; the query is not part of the match.
const NEEDS: [RegExp, string][] = [
  [/^\/accounts\/[^/]+\/tokens(\/|$)/, 'Account API Tokens'],
  [/^\/user\/tokens(\/|$)/, 'API Tokens'],
  [/^\/accounts\/[^/]+\/access\/(apps|policies)(\/|$)/, 'Access: Apps and Policies'],
  [
    /^\/accounts\/[^/]+\/access\/(organizations|identity_providers)(\/|$)/,
    'Access: Organizations, Identity Providers, and Groups',
  ],
  [/^\/accounts\/[^/]+\/d1\//, 'D1'],
  [/^\/accounts\/[^/]+\/r2\//, 'Workers R2 Storage'],
  [/^\/accounts\/[^/]+\/workers\/(scripts|domains)(\/|$)/, 'Workers Scripts'],
  [/^\/zones\/[^/]+\/dns_records(\/|$)/, 'DNS'],
  [/^\/zones$/, 'Zone'],
  [/^\/accounts\/[^/]+$/, 'Account Settings'],
];

export const permissionFor = (method: string, path: string) => {
  const bare = path.split('?')[0];
  const found = NEEDS.find(([re]) => re.test(bare));
  return found && `${found[1]} ${method === 'GET' ? 'Read' : 'Write'}`;
};

const R2_NOT_ENABLED = 10042;

export class CloudflareError extends DeployError {
  constructor(
    readonly status: number,
    readonly errors: CfError[],
    method: string,
    path: string,
  ) {
    // Cloudflare's own list, read only as far as it is one, so a malformed
    // answer still gives a message rather than a TypeError.
    const list = (Array.isArray(errors) ? errors : []).filter((e): e is CfError => typeof e === 'object' && e !== null);
    // Code 10042 is an account without R2, whatever the token holds (#153).
    const noR2 = list.some((e) => e.code === R2_NOT_ENABLED);
    const needs = status === 403 && !noR2 ? permissionFor(method, path) : undefined;
    const hint = noR2
      ? '; R2 is not enabled on this account: enable it in the dashboard (R2 Object Storage), then run again'
      : needs
        ? `; the token may lack ${needs}`
        : '';
    super(
      `Cloudflare refused ${method} ${path} (${status}): ${list.map((e) => `${e.code ?? ''} ${e.message ?? ''}`.trim()).join('; ') || 'no reason given'}${hint}`,
    );
  }
}

export const readToken = (file: string): string => {
  const token = (() => {
    try {
      return readFileSync(file, 'utf8').trim();
    } catch {
      return '';
    }
  })();
  if (!token) throw new DeployError(`--token-file must name a readable file holding a Cloudflare API token`);
  return token;
};

type Envelope = {
  success?: boolean;
  errors?: CfError[];
  result?: unknown;
  result_info?: { page?: number; total_pages?: number; cursor?: string };
};

export type Cloudflare = {
  call: <T = unknown>(method: string, path: string, body?: unknown) => Promise<T>;
  // Every item of a page-numbered list.
  list: <T = unknown>(path: string) => Promise<T[]>;
  // One call, with the cursor for the next page when the list is cursored.
  page: <T = unknown>(method: string, path: string) => Promise<{ result: T; cursor?: string }>;
  // 404 is an answer here (the thing does not exist), not a failure.
  exists: (path: string) => Promise<boolean>;
};

export const cloudflare = (tokenFile: string, fetchImpl: typeof fetch = fetch): Cloudflare => {
  const request = async (method: string, path: string, body?: unknown) => {
    const res = await fetchImpl(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${readToken(tokenFile)}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
    });
    const envelope = await res.json().then(
      (v) => v as Envelope,
      () => null,
    );
    return { res, envelope };
  };
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const { res, envelope } = await request(method, path, body);
    if (!envelope)
      throw new DeployError(`Cloudflare sent a response that is not JSON for ${method} ${path} (${res.status})`);
    if (!res.ok || envelope.success !== true)
      throw new CloudflareError(res.status, envelope.errors ?? [], method, path);
    return envelope.result as T;
  };
  const list = async <T>(path: string): Promise<T[]> => {
    const items: T[] = [];
    let firstOfPrevious = '';
    const sep = path.includes('?') ? '&' : '?';
    for (let page = 1; ; page++) {
      const { res, envelope } = await request('GET', `${path}${sep}page=${page}&per_page=${PER_PAGE}`);
      if (!envelope)
        throw new DeployError(`Cloudflare sent a response that is not JSON for GET ${path} (${res.status})`);
      if (!res.ok || envelope.success !== true)
        throw new CloudflareError(res.status, envelope.errors ?? [], 'GET', path);
      const batch = Array.isArray(envelope.result) ? (envelope.result as T[]) : [];
      // A list that ignores page would hand back page 1 forever.
      const key = JSON.stringify(batch[0] ?? null);
      if (page > 1 && batch.length > 0 && key === firstOfPrevious) {
        throw new DeployError(`Cloudflare returned the same page twice for GET ${path}; refusing to loop`);
      }
      firstOfPrevious = key;
      items.push(...batch);
      // Not every list reports its page count; without one, a short page is the last.
      const total = envelope.result_info?.total_pages;
      const last = total === undefined ? batch.length < PER_PAGE : page >= total;
      if (last || batch.length === 0) return items;
    }
  };
  const exists = async (path: string) => {
    const { res, envelope } = await request('GET', path);
    if (res.status === 404) return false;
    if (!envelope) throw new DeployError(`Cloudflare sent a response that is not JSON for GET ${path} (${res.status})`);
    if (!res.ok || envelope.success !== true) throw new CloudflareError(res.status, envelope.errors ?? [], 'GET', path);
    return true;
  };
  const page = async <T>(method: string, path: string) => {
    const { res, envelope } = await request(method, path);
    if (!envelope)
      throw new DeployError(`Cloudflare sent a response that is not JSON for ${method} ${path} (${res.status})`);
    if (!res.ok || envelope.success !== true)
      throw new CloudflareError(res.status, envelope.errors ?? [], method, path);
    return { result: envelope.result as T, cursor: envelope.result_info?.cursor || undefined };
  };
  return { call, list, exists, page };
};
