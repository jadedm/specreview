import type { HistoryEntry, Section, Status } from '@specreview/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const send = async <T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<T> => {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? `HTTP_${res.status}`, data?.error?.message ?? '');
  return data as T;
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
export type Ticket =
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
  | { number: number; notFound: true };
// History is sent to the team only.
export type PageData = { title: string; hash: string; issues: number[]; sections: Section[]; history?: HistoryEntry[] };
export type Pages = { commit: string; pages: Record<string, PageData> };

const q = (page: string) => `page=${encodeURIComponent(page)}`;

// Every path is under the site's base, /<repo>/.
export const apiFor = (base: string) => {
  const at = (path: string) => `${base}_api/${path}`;
  return {
    me: () => send<Me>('GET', at('me')),
    pages: () => send<Pages>('GET', at('pages')),
    comments: (page: string) => send<Thread[]>('GET', at(`comments?${q(page)}`)),
    statuses: () => send<PageStatus[]>('GET', at('status')),
    tickets: (page: string) => send<Ticket[]>('GET', at(`tickets?${q(page)}`)),
    comment: (input: { page: string; heading: string; quote: string; body: string }) =>
      send<{ id: string }>('POST', at('comments'), input),
    reply: (id: string, body: string) => send<{ id: string }>('POST', at(`comments/${id}/replies`), { body }),
    resolve: (id: string, pr?: number) => send('POST', at(`comments/${id}/resolve`), pr ? { pr } : {}),
    reopen: (id: string) => send('POST', at(`comments/${id}/reopen`), {}),
    setStatus: (input: { page: string; status: Status; expectedVersion: number; hash: string }) =>
      send<{ labels: string }>('POST', at('status'), input),
    oldVersion: async (commit: string, path: string) => {
      const res = await fetch(`${base}_history/${commit}/${path}`, { credentials: 'same-origin' });
      if (!res.ok) throw new ApiError(res.status, 'HISTORY_UNAVAILABLE', 'That version could not be loaded.');
      return res.text();
    },
  };
};

export type Api = ReturnType<typeof apiFor>;
