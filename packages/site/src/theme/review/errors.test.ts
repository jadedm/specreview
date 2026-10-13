// @vitest-environment happy-dom
// #29: why a panel request failed, through the real API client with fetch
// stubbed. Case numbers are the ticket's.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFor, ApiError, NETWORK, SIGNED_OUT } from './api';
import {
  BOTTOM_MOUNT,
  createReview,
  explain,
  MAY_HAVE_SAVED,
  NETWORK_TEXT,
  NO_ACCESS_TEXT,
  SIGNED_OUT_TEXT,
  TOP_MOUNT,
} from './start';

const team = { email: 'dev@x.example', role: 'team' };
const PAGES = {
  commit: 'c',
  pages: {
    a: {
      title: 'A',
      hash: 'h',
      issues: [],
      sections: [{ id: 'limits', title: 'Limits', text: 'x' }],
      history: [
        { commit: 'b'.repeat(40), date: '2026-10-08T00:00:00Z', author: 'Dev', pr: 3, path: 'a.md', hash: 'h' },
        { commit: 'a'.repeat(40), date: '2026-10-07T00:00:00Z', author: 'Dev', pr: 2, path: 'a.md', hash: 'g' },
      ],
    },
  },
};
const STATUS = [
  {
    page: 'a',
    title: 'A',
    hash: 'h',
    status: 'pending',
    version: 0,
    changedBy: null,
    changedAt: null,
    wasReadyAt: null,
  },
];

// An opaque redirect, as fetch reports a 302 when told not to follow it.
// happy-dom cannot build one, so it is a stand-in with the fields used.
const accessRedirect = () => ({ type: 'opaqueredirect', status: 0, ok: false, headers: new Headers() }) as Response;

type Route = (url: string, init: RequestInit) => Response | Promise<Response>;
const hub = (writes: Route = () => Response.json({})): Route => {
  return (url, init) => {
    if (init.method === 'POST') return writes(url, init);
    if (url.endsWith('_api/me')) return Response.json(team);
    if (url.endsWith('_api/pages')) return Response.json(PAGES);
    if (url.endsWith('_api/status')) return Response.json(STATUS);
    if (url.includes('_api/comments')) return Response.json([]);
    if (url.includes('_history/')) return new Response('old text');
    return Response.json([]);
  };
};
const calls: { url: string; init: RequestInit }[] = [];
const stub = (route: Route) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      return route(url, init);
    }),
  );

beforeEach(() => {
  calls.length = 0;
  document.body.innerHTML = `<div class="vp-doc"><div><h2 id="limits">Limits</h2><p>Text</p></div></div><div id="${TOP_MOUNT}"></div><div id="${BOTTOM_MOUNT}"></div>`;
});
afterEach(() => vi.unstubAllGlobals());

const notice = () => document.querySelector('[role="alert"]')?.textContent ?? null;
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
const button = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text)!;
const writeControls = () => [
  ...document.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>(
    `#${TOP_MOUNT} button[data-write], #${BOTTOM_MOUNT} button[data-write], #${BOTTOM_MOUNT} textarea`,
  ),
];

describe('29: the API client says what happened', () => {
  it('1: an Access redirect is a sign-in that expired', async () => {
    stub(() => accessRedirect());
    const err = await apiFor('/s/')
      .me()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(SIGNED_OUT);
    expect(explain(err)).toBe(SIGNED_OUT_TEXT);
  });

  it('2: a fetch that fails is "could not reach the hub"', async () => {
    stub(() => {
      throw new TypeError('Failed to fetch');
    });
    const err = await apiFor('/s/')
      .me()
      .catch((e: unknown) => e);
    expect((err as ApiError).code).toBe(NETWORK);
    expect(explain(err)).toBe(NETWORK_TEXT);
  });

  it('3: an unexplained error names its status and Cloudflare reference', async () => {
    stub(
      () => new Response('<html>bad gateway</html>', { status: 502, headers: { 'cf-ray': '8f1c2a3b4d5e6f70-MRS' } }),
    );
    const err = await apiFor('/s/')
      .me()
      .catch((e: unknown) => e);
    expect(explain(err)).toBe('Something went wrong (HTTP 502, reference 8f1c2a3b4d5e6f70-MRS). Reload and try again.');
  });

  it('4: with no body and no reference, the status alone', async () => {
    stub(() => new Response(null, { status: 503 }));
    const err = await apiFor('/s/')
      .me()
      .catch((e: unknown) => e);
    expect(explain(err)).toBe('Something went wrong (HTTP 503). Reload and try again.');
  });

  it("5, 6: the hub's own messages are unchanged", async () => {
    stub(() => Response.json({ error: { code: 'RATE_LIMITED', message: 'Too many writes.' } }, { status: 429 }));
    expect(
      explain(
        await apiFor('/s/')
          .me()
          .catch((e: unknown) => e),
      ),
    ).toBe('Too many writes.');
    stub(() => Response.json({ error: { code: 'UNAUTHORIZED', message: 'Sign in to use this.' } }, { status: 401 }));
    expect(
      explain(
        await apiFor('/s/')
          .me()
          .catch((e: unknown) => e),
      ),
    ).toBe(SIGNED_OUT_TEXT);
  });

  it('7: every request, API and history, is sent without following redirects', async () => {
    stub(hub());
    const api = apiFor('/s/');
    await api.me();
    await api.comment({ page: 'a', heading: 'limits', quote: 'q', body: 'b' });
    await api.oldVersion('a'.repeat(40), 'a.md');
    expect(calls).toHaveLength(3);
    for (const { init } of calls) {
      expect(init.redirect).toBe('manual');
      expect(init.credentials).toBe('same-origin');
    }
  });

  it('13: an old version behind an expired sign-in, or an unreachable hub', async () => {
    stub(() => accessRedirect());
    expect(
      explain(
        await apiFor('/s/')
          .oldVersion('a'.repeat(40), 'a.md')
          .catch((e: unknown) => e),
      ),
    ).toBe(SIGNED_OUT_TEXT);
    stub(() => {
      throw new TypeError('Failed to fetch');
    });
    expect(
      explain(
        await apiFor('/s/')
          .oldVersion('a'.repeat(40), 'a.md')
          .catch((e: unknown) => e),
      ),
    ).toBe(NETWORK_TEXT);
  });
});

describe('29: the panel', () => {
  it('1: a load behind an expired sign-in shows the sign-in message', async () => {
    stub(() => accessRedirect());
    await createReview(apiFor('/s/'), '/s/').render('a');
    expect(notice()).toBe(SIGNED_OUT_TEXT);
  });

  it('12: a write answered by an Access redirect releases the panel with the sign-in message', async () => {
    let posts = 0;
    stub(
      hub(() => {
        posts++;
        return accessRedirect();
      }),
    );
    await createReview(apiFor('/s/'), '/s/').render('a');
    button('Move to in review').click();
    await settle();
    expect(notice()).toBe(SIGNED_OUT_TEXT);
    expect(button('Move to in review').disabled).toBe(false);
    // Released for real: a second click sends a second request.
    button('Move to in review').click();
    await settle();
    expect(posts).toBe(2);
  });

  it('11: a write whose request failed keeps the write controls disabled', async () => {
    stub(
      hub(() => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await createReview(apiFor('/s/'), '/s/').render('a');
    button('Move to in review').click();
    await settle();
    expect(notice()).toBe(MAY_HAVE_SAVED);
    expect(writeControls().length).toBeGreaterThan(0);
    expect(writeControls().every((c) => c.disabled)).toBe(true);
    expect(document.querySelector('[aria-busy]')).toBeNull();
    expect(button('Move to in review')).toBeDefined();
  });

  it('13: "Diff with latest" behind an expired sign-in shows the sign-in message', async () => {
    let expired = false;
    stub((url, init) => (expired ? accessRedirect() : hub()(url, init)));
    await createReview(apiFor('/s/'), '/s/').render('a');
    expired = true;
    button('Diff with latest').click();
    await settle();
    expect(notice()).toBe(SIGNED_OUT_TEXT);
  });
});

describe('29: after review', () => {
  it('a write answered by a server error keeps the panel held, with the reference', async () => {
    stub(hub(() => new Response('<html>timeout</html>', { status: 502, headers: { 'cf-ray': 'abc123-MRS' } })));
    await createReview(apiFor('/s/'), '/s/').render('a');
    button('Move to in review').click();
    await settle();
    expect(notice()).toBe(
      'Your change may have been saved (HTTP 502, reference abc123-MRS). Reload the page to check.',
    );
    expect(writeControls().every((c) => c.disabled)).toBe(true);
  });

  it("the hub's own crash message carries its status and reference", async () => {
    stub(() =>
      Response.json(
        { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' } },
        { status: 500, headers: { 'cf-ray': 'def456-MRS' } },
      ),
    );
    expect(
      explain(
        await apiFor('/s/')
          .me()
          .catch((e: unknown) => e),
      ),
    ).toBe('Something went wrong (HTTP 500, reference def456-MRS).');
  });

  it('a JSON error with a code and no message carries the reference', async () => {
    stub(() => Response.json({ error: { code: 'X' } }, { status: 418, headers: { 'cf-ray': 'ghi789-MRS' } }));
    expect(
      explain(
        await apiFor('/s/')
          .me()
          .catch((e: unknown) => e),
      ),
    ).toBe('Something went wrong (HTTP 418, reference ghi789-MRS). Reload and try again.');
  });

  it("Access refusing by policy says the account cannot read the site; the hub's own 403 keeps its message", async () => {
    stub(() => new Response('<html>Forbidden</html>', { status: 403 }));
    expect(
      explain(
        await apiFor('/s/')
          .me()
          .catch((e: unknown) => e),
      ),
    ).toBe(NO_ACCESS_TEXT);
    stub(() => Response.json({ error: { code: 'FORBIDDEN', message: 'Readers cannot do that.' } }, { status: 403 }));
    expect(
      explain(
        await apiFor('/s/')
          .me()
          .catch((e: unknown) => e),
      ),
    ).toBe('Readers cannot do that.');
  });

  it('an old version that fails names its status and reference', async () => {
    stub(() => new Response('gone', { status: 502, headers: { 'cf-ray': 'jkl012-MRS' } }));
    expect(
      explain(
        await apiFor('/s/')
          .oldVersion('a'.repeat(40), 'a.md')
          .catch((e: unknown) => e),
      ),
    ).toBe('That version could not be loaded (HTTP 502, reference jkl012-MRS).');
  });

  it('a write refused with a 4xx is a known failure: the panel is released', async () => {
    stub(hub(() => Response.json({ error: { code: 'CONFLICT', message: 'Changed meanwhile.' } }, { status: 409 })));
    await createReview(apiFor('/s/'), '/s/').render('a');
    button('Move to in review').click();
    await settle();
    expect(notice()).toBe('Changed meanwhile.');
    expect(button('Move to in review').disabled).toBe(false);
  });
});
