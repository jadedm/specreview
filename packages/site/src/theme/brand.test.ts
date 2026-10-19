// @vitest-environment happy-dom
// #33: the organisation's logo and name in the nav bar, through the real API
// client with fetch stubbed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, ref } from 'vue';

vi.mock('vitepress', () => ({ useData: () => ({ site: ref({ base: '/s/' }) }) }));
const { OrgBrand, BRAND_CLASS } = await import('./brand');

const calls: string[] = [];
const stub = (answer: () => Response | Promise<Response>) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url);
      return answer();
    }),
  );
afterEach(() => {
  vi.unstubAllGlobals();
  calls.length = 0;
  document.body.innerHTML = '';
});

const mount = async () => {
  const host = document.createElement('div');
  document.body.append(host);
  createApp(OrgBrand).mount(host);
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  await nextTick();
  return host;
};

describe('33: the header brand', () => {
  it('11: name and logo after the hub answers; the logo is from the hub, its alt the name', async () => {
    stub(() => Response.json({ name: 'Acme', logo: true }));
    const host = await mount();
    expect(calls).toEqual(['/s/_api/brand']);
    const img = host.querySelector<HTMLImageElement>(`.${BRAND_CLASS}-logo`)!;
    expect(img.getAttribute('src')).toBe('/s/_api/brand/logo');
    expect(img.getAttribute('alt')).toBe('Acme');
    const name = host.querySelector(`.${BRAND_CLASS}-name`)!;
    expect(name.textContent).toBe('Acme');
    // #53: the whole brand is one link to the hub's index.
    const link = host.querySelector(`a.${BRAND_CLASS}`)!;
    expect(link.getAttribute('href')).toBe('/');
    // A full load, not VitePress's in-site router (which keeps clicks inside the base).
    expect(link.getAttribute('target')).toBe('_self');
    expect(link.contains(img)).toBe(true);
    // Read once, through the image's alt.
    expect(name.getAttribute('aria-hidden')).toBe('true');
  });

  it('review: a logo that fails to load gives way to the name', async () => {
    stub(() => Response.json({ name: 'Acme', logo: true }));
    const host = await mount();
    host.querySelector('img')!.dispatchEvent(new Event('error'));
    await nextTick();
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector(`.${BRAND_CLASS}-name`)?.getAttribute('aria-hidden')).toBeNull();
    expect(host.textContent).toBe('Acme');
  });

  it('11: a name without a logo shows the name only', async () => {
    stub(() => Response.json({ name: 'Acme', logo: false }));
    const host = await mount();
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector(`.${BRAND_CLASS}-name`)?.getAttribute('aria-hidden')).toBeNull();
    expect(host.textContent).toBe('Acme');
  });

  it('2, 12: no brand, an error, or no answer shows nothing', async () => {
    for (const answer of [
      () => Response.json({ name: null, logo: false }),
      () => new Response('down', { status: 503 }),
      () => Promise.reject(new TypeError('Failed to fetch')),
    ]) {
      stub(answer);
      const host = await mount();
      expect(host.querySelector(`.${BRAND_CLASS}`)).toBeNull();
      expect(host.textContent).toBe('');
      document.body.innerHTML = '';
    }
  });

  it('a name with markup is text, never markup', async () => {
    stub(() => Response.json({ name: '<img src=x onerror=alert(1)>', logo: false }));
    const host = await mount();
    expect(host.querySelectorAll('img')).toHaveLength(0);
    expect(host.textContent).toBe('<img src=x onerror=alert(1)>');
  });
});
