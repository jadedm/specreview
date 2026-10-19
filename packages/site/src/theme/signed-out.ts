// #123: a reader whose sign-in expired with a tab open moves to another page;
// VitePress fetches that page's chunk, Access answers with its login page on
// another origin, the import fails, and VitePress shows its 404 with no word
// of why (router.js retries once with hashmap.json, behind Access too).
// This fills the layout's not-found slot: it renders nothing, so VitePress's
// own 404 shows, unless the page is one this build has and the hub says the
// sign-in is gone; then it says so, with a way to sign in again.
import { useData, useRoute } from 'vitepress';
import { defineComponent, h, onMounted, ref, watch } from 'vue';
import { SIGNED_OUT_TEXT } from './review/start';

declare global {
  interface Window {
    __VP_HASH_MAP__?: Record<string, string>;
  }
}

// The chunk key VitePress looks a page up by (pathToFile in its client):
// /base/a/b.html and /base/a/b are a_b.md, /base/a/ is a_index.md, with the
// other index form tried as well. Names are the router's [A-Za-z0-9._~-], so
// VitePress's file-name sanitizing changes nothing.
export const knownPage = (path: string, base: string, map: Record<string, string> = {}): boolean => {
  let page: string;
  try {
    page = decodeURIComponent(path);
  } catch {
    return false;
  }
  if (!page.startsWith(base)) return false;
  page = page
    .replace(/\.html$/, '')
    .replace(/\/$/, '/index')
    .slice(base.length);
  const key = `${page.replace(/\//g, '_') || 'index'}.md`.toLowerCase();
  const other = key.endsWith('_index.md') ? `${key.slice(0, -'_index.md'.length)}.md` : `${key.slice(0, -3)}_index.md`;
  return Object.hasOwn(map, key) || Object.hasOwn(map, other);
};

// Access sends an expired session to its login (a redirect, unreadable with
// redirect: 'manual'); the hub answers a missing token with 401. Anything
// else, a failure included, is not taken as signed out.
export const signedOut = async (base: string): Promise<boolean> => {
  const res = await fetch(`${base}_api/me`, { redirect: 'manual', credentials: 'same-origin' }).catch(() => null);
  return res !== null && (res.type === 'opaqueredirect' || res.status === 401);
};

// A public site's pages load without a sign-in (#20), and an anonymous
// visitor's _api/me is always 401: its 404s are real.
const publicSite = () =>
  document.querySelector('meta[name="specreview-visibility"]')?.getAttribute('content') === 'public';

// Set by the probe, read by the layout: while true the layout fills its
// not-found slot with the message; otherwise the slot stays empty and
// VitePress shows its own 404 (it does not export that component, and
// anything in the slot replaces it).
export const expired = ref(false);

// Renders nothing; sits in a slot every page has and checks each 404.
// The page list as built, kept from the first page load: when a chunk fails
// VitePress refetches hashmap.json and stores whatever comes back, which,
// signed out, can be the hub's 401 error rather than a list of pages.
let built: Record<string, string> | undefined;
export const forgetBuiltPages = () => {
  built = undefined;
};

export const SignedOutProbe = defineComponent({
  name: 'SignedOutProbe',
  setup() {
    const { site, page } = useData();
    const route = useRoute();
    const check = async () => {
      expired.value = false;
      const path = route.path;
      if (!page.value.isNotFound || publicSite() || !knownPage(path, site.value.base, built)) return;
      const out = await signedOut(site.value.base);
      // Moved on meanwhile: this answer is about a page no longer shown.
      if (route.path !== path) return;
      expired.value = out;
    };
    // In the browser only: VitePress renders this layout on the server too.
    onMounted(() => {
      built ??= { ...window.__VP_HASH_MAP__ };
      void check();
    });
    watch(() => [route.path, page.value.isNotFound], check);
    return () => null;
  },
});

export const SignedOutMessage = () =>
  // An alert: it replaces the 404 a screen reader may already have read.
  h('div', { class: 'sr-signed-out', role: 'alert' }, [
    h('h1', null, 'Signed out'),
    h('p', null, SIGNED_OUT_TEXT),
    h('button', { type: 'button', class: 'sr-signed-out-reload', onClick: () => location.reload() }, 'Reload'),
  ]);
