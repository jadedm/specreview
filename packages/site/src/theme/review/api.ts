import type { HistoryEntry, Section, Status } from '@specreview/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    // For an error the hub did not explain: its status and request id.
    readonly reference = '',
  ) {
    super(message);
  }
}

// The hub's API and history paths never redirect, so a redirect can only be
// Cloudflare Access sending an expired session to its login page. Followed,
// that page is on another origin: the browser refuses it and the request
// ends with no response at all (#29). Not followed, it is a clear answer.
export const SIGNED_OUT = 'SIGNED_OUT';
// fetch itself failed: offline, DNS, a blocked request. For a write the
// outcome is unknown, since the hub may have saved it before the answer was
// lost.
export const NETWORK = 'NETWORK';

const request = async (url: string, init: RequestInit): Promise<Response> => {
  const res = await fetch(url, { ...init, credentials: 'same-origin', redirect: 'manual' }).catch(() => {
    throw new ApiError(0, NETWORK, '');
  });
  if (res.type === 'opaqueredirect') throw new ApiError(401, SIGNED_OUT, '');
  return res;
};

// The status, and Cloudflare's request id when the response carries one, so a
// failure the hub did not explain can still be found in its logs.
export const reference = (res: Response) => {
  const ray = res.headers.get('cf-ray');
  return `HTTP ${res.status}${ray ? `, reference ${ray}` : ''}`;
};

const send = async <T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<T> => {
  const res = await request(url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
  if (res.ok) return data as T;
  const error = data?.error;
  throw new ApiError(res.status, error?.code ?? `HTTP_${res.status}`, error?.message ?? '', reference(res));
};

export type Me = { email: string; role: 'reader' | 'team' | 'approver' };
// `author` and `resolvedBy` are what the hub lets this person see: an email
// for the team, "You", the team's label or "Reader" for an outside reader.
// `mine` says whether it is the caller's own.
export type Reply = { id: string; author: string; mine: boolean; body: string; createdAt: string };
export type Thread = {
  id: string;
  heading: string;
  quote: string;
  // The text either side of the quote (#38); empty for threads posted before.
  prefix?: string;
  suffix?: string;
  // Set for a reader when the quoted text has left the page; quote is then empty.
  quoteHidden?: boolean;
  pageHash: string;
  author: string;
  mine: boolean;
  body: string;
  state: 'open' | 'resolved';
  resolvedBy: string | null;
  resolvedPr: number | null;
  resolvedAt: string | null;
  createdAt: string;
  outdated: boolean;
  replies: Reply[];
};
export type PageStatus = {
  page: string;
  title: string;
  hash: string;
  status: Status;
  version: number;
  changedBy: string | null;
  changedAt: string | null;
  wasReadyAt: string | null;
};
// Title and link are the team's; a reader gets the number, state and label.
// On a site with several ticket repos (#90) each ticket names its repo.
export type Ticket = { repo?: string } & (
  | {
      number: number;
      title?: string;
      url?: string;
      state: string;
      labels: string[];
      fetchedAt: string;
      stale: boolean;
    }
  | { number: number; unavailable: true }
  | { number: number; notFound: true }
  | { number: number; notLinked: true }
);
// History is sent to the team only.
export type PageData = {
  title: string;
  hash: string;
  issues: (number | string)[];
  sections: Section[];
  history?: HistoryEntry[];
};
export type Pages = { commit: string; pages: Record<string, PageData> };
// The organisation's name and whether it has a logo (#33).
export type Brand = { name: string | null; logo: boolean };

const q = (page: string) => `page=${encodeURIComponent(page)}`;

// Every path is under the site's base, /<repo>/.
export const apiFor = (base: string) => {
  const at = (path: string) => `${base}_api/${path}`;
  return {
    me: () => send<Me>('GET', at('me')),
    brand: () => send<Brand>('GET', at('brand')),
    logoUrl: () => at('brand/logo'),
    pages: () => send<Pages>('GET', at('pages')),
    comments: (page: string) => send<Thread[]>('GET', at(`comments?${q(page)}`)),
    statuses: () => send<PageStatus[]>('GET', at('status')),
    tickets: (page: string) => send<Ticket[]>('GET', at(`tickets?${q(page)}`)),
    comment: (input: {
      page: string;
      heading: string;
      quote: string;
      prefix?: string;
      suffix?: string;
      body: string;
    }) => send<{ id: string }>('POST', at('comments'), input),
    reply: (id: string, body: string) => send<{ id: string }>('POST', at(`comments/${id}/replies`), { body }),
    resolve: (id: string, pr?: number) => send('POST', at(`comments/${id}/resolve`), pr ? { pr } : {}),
    reopen: (id: string) => send('POST', at(`comments/${id}/reopen`), {}),
    setStatus: (input: { page: string; status: Status; expectedVersion: number; hash: string }) =>
      send<{ labels: string }>('POST', at('status'), input),
    oldVersion: async (commit: string, path: string) => {
      const res = await request(`${base}_history/${commit}/${path}`, {});
      if (!res.ok)
        throw new ApiError(res.status, 'HISTORY_UNAVAILABLE', `That version could not be loaded (${reference(res)}).`);
      return res.text();
    },
  };
};

export type Api = ReturnType<typeof apiFor>;
