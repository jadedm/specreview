// @vitest-environment happy-dom
// #123: a 404 shown because the sign-in expired says so; a real 404 stays.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type App, createApp, nextTick, reactive, ref } from 'vue';

const route = reactive({ path: '/s/guide/a' });
const page = ref({ isNotFound: true });
vi.mock('vitepress', () => ({ useData: () => ({ site: ref({ base: '/s/' }), page }), useRoute: () => route }));
const { expired, forgetBuiltPages, knownPage, SignedOutMessage, SignedOutProbe, signedOut } =
  await import('./signed-out');
const { SIGNED_OUT_TEXT } = await import('./review/start');

const MAP = { 'index.md': 'a', 'guide_a.md': 'b', 'guide_index.md': 'c', 'notes.md': 'd' };
const calls: string[] = [];
const apps: App[] = [];
const answer = (res: () => Response | Promise<Response>) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url);
      return res();
    }),
  );
const redirect = () => Object.defineProperty(new Response(null, { status: 200 }), 'type', { value: 'opaqueredirect' });
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  await nextTick();
};
const mount = async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const app = createApp(SignedOutProbe);
  app.mount(host);
  apps.push(app);
  await flush();
  return host;
};

beforeEach(() => {
  forgetBuiltPages();
  window.__VP_HASH_MAP__ = MAP;
  route.path = '/s/guide/a';
  page.value = { isNotFound: true };
  expired.value = false;
});
afterEach(() => {
  // A probe left mounted would ask again when the next test moves the route.
  for (const app of apps.splice(0)) app.unmount();
  vi.unstubAllGlobals();
  calls.length = 0;
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('123: which paths are pages of this build', () => {
  it('clean URLs, .html, folders and the home page; nothing outside the base or unknown', () => {
    for (const p of ['/s/', '/s/guide/a', '/s/guide/a.html', '/s/guide/', '/s/guide', '/s/notes', '/s/Notes'])
      expect(knownPage(p, '/s/', MAP), p).toBe(true);
    for (const p of ['/s/missing', '/s/guide/b', '/other/notes', '/s/%E0%A4%A'])
      expect(knownPage(p, '/s/', MAP), p).toBe(false);
    expect(knownPage('/s/notes', '/s/')).toBe(false);
  });
});

describe('123: is the sign-in gone', () => {
  it('2, 1: a 401, or Access redirecting to its login, is signed out; asked without following', async () => {
    const init: RequestInit[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, i: RequestInit) => {
        init.push(i);
        return new Response(null, { status: 401 });
      }),
    );
    expect(await signedOut('/s/')).toBe(true);
    expect(init[0]).toMatchObject({ redirect: 'manual', credentials: 'same-origin' });
    answer(redirect);
    expect(await signedOut('/s/')).toBe(true);
  });

  it('3, 4: 200, 403 or a network failure is not', async () => {
    answer(() => Response.json({ email: 'a@b.example' }));
    expect(await signedOut('/s/')).toBe(false);
    answer(() => new Response(null, { status: 403 }));
    expect(await signedOut('/s/')).toBe(false);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))),
    );
    expect(await signedOut('/s/')).toBe(false);
  });
});

describe('123: the probe on a 404', () => {
  it('1: a page of this build, signed out: marked expired; asked at the site base', async () => {
    answer(() => new Response(null, { status: 401 }));
    await mount();
    expect(calls).toEqual(['/s/_api/me']);
    expect(expired.value).toBe(true);
  });

  it('review: the page list as built counts, not what VitePress refetched after the failure', async () => {
    answer(() => new Response(null, { status: 401 }));
    route.path = '/s/notes';
    page.value = { isNotFound: false };
    await mount();
    // VitePress's retry stored the hub's error as the map.
    window.__VP_HASH_MAP__ = { error: 'x' } as unknown as Record<string, string>;
    route.path = '/s/guide/a';
    page.value = { isNotFound: true };
    await flush();
    expect(expired.value).toBe(true);
  });

  it('3: signed in: the 404 stays', async () => {
    answer(() => Response.json({ email: 'a@b.example' }));
    await mount();
    expect(expired.value).toBe(false);
  });

  it('10: a page this build does not have, signed out: the 404 stays, nothing asked', async () => {
    answer(() => new Response(null, { status: 401 }));
    route.path = '/s/missing';
    await mount();
    expect([calls, expired.value]).toEqual([[], false]);
  });

  it('5: a public site: nothing asked, the 404 stays', async () => {
    answer(() => new Response(null, { status: 401 }));
    const meta = document.createElement('meta');
    meta.name = 'specreview-visibility';
    meta.content = 'public';
    document.head.append(meta);
    await mount();
    expect([calls, expired.value]).toEqual([[], false]);
  });

  it('not a 404: nothing asked', async () => {
    answer(() => new Response(null, { status: 401 }));
    page.value = { isNotFound: false };
    await mount();
    expect([calls, expired.value]).toEqual([[], false]);
  });

  it('8: moved on before the answer: nothing set; moving on clears the message', async () => {
    let release: (r: Response) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((r) => (release = r))),
    );
    await mount();
    route.path = '/s/notes';
    page.value = { isNotFound: false };
    await flush();
    release(new Response(null, { status: 401 }));
    await flush();
    expect(expired.value).toBe(false);
    expired.value = true;
    route.path = '/s/guide/';
    await flush();
    expect(expired.value).toBe(false);
  });
});

describe('123: the message', () => {
  it('6, 11: the review panel’s words and a real Reload button', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    const host = document.createElement('div');
    document.body.append(host);
    createApp(SignedOutMessage).mount(host);
    expect(host.querySelector('.sr-signed-out')?.getAttribute('role')).toBe('alert');
    expect(host.querySelector('h1')?.textContent).toBe('Signed out');
    expect(host.querySelector('p')?.textContent).toBe(SIGNED_OUT_TEXT);
    const button = host.querySelector('button')!;
    expect([button.type, button.textContent]).toEqual(['button', 'Reload']);
    button.click();
    expect(reload).toHaveBeenCalledOnce();
  });
});
