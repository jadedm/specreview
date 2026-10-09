// The Cloudflare API, as setup and secret use it. The token is read from its
// file at every call and only ever placed in a request header.
import { readFileSync } from 'node:fs';
import { DeployError } from './org';

const API = 'https://api.cloudflare.com/client/v4';

export type CfError = { code?: number; message?: string };

export class CloudflareError extends DeployError {
  constructor(
    readonly status: number,
    readonly errors: CfError[],
    what: string,
  ) {
    super(
      `Cloudflare refused ${what} (${status}): ${errors.map((e) => `${e.code ?? ''} ${e.message ?? ''}`.trim()).join('; ') || 'no reason given'}`,
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
      throw new CloudflareError(res.status, envelope.errors ?? [], `${method} ${path}`);
    return envelope.result as T;
  };
  const list = async <T>(path: string): Promise<T[]> => {
    const items: T[] = [];
    const sep = path.includes('?') ? '&' : '?';
    for (let page = 1; ; page++) {
      const { res, envelope } = await request('GET', `${path}${sep}page=${page}&per_page=50`);
      if (!envelope)
        throw new DeployError(`Cloudflare sent a response that is not JSON for GET ${path} (${res.status})`);
      if (!res.ok || envelope.success !== true)
        throw new CloudflareError(res.status, envelope.errors ?? [], `GET ${path}`);
      const batch = Array.isArray(envelope.result) ? (envelope.result as T[]) : [];
      items.push(...batch);
      const total = envelope.result_info?.total_pages ?? 1;
      if (page >= total || batch.length === 0) return items;
    }
  };
  const exists = async (path: string) => {
    const { res, envelope } = await request('GET', path);
    if (res.status === 404) return false;
    if (!envelope) throw new DeployError(`Cloudflare sent a response that is not JSON for GET ${path} (${res.status})`);
    if (!res.ok || envelope.success !== true)
      throw new CloudflareError(res.status, envelope.errors ?? [], `GET ${path}`);
    return true;
  };
  return { call, list, exists };
};
