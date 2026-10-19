// @vitest-environment happy-dom
// #123: the theme's layout puts the signed-out message in VitePress's
// not-found slot only while the probe says the sign-in expired; otherwise the
// slot stays empty and VitePress's own 404 shows. VitePress's layout is a
// stand-in that renders the slot, or its 404, as VPContent does.
import { describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, ref } from 'vue';

vi.mock('vitepress/theme-without-fonts', () => ({
  default: {
    Layout: defineComponent({
      setup(_, { slots }) {
        return () => h('main', [slots['not-found'] ? slots['not-found']() : h('p', { class: 'vp-404' }, '404')]);
      },
    }),
  },
}));
vi.mock('vitepress', () => ({
  useData: () => ({ site: ref({ base: '/s/' }), page: ref({ isNotFound: false }) }),
  useRoute: () => ({ path: '/s/' }),
}));
const theme = (await import('./index')).default;
const { expired } = await import('./signed-out');

describe('123: the layout and the not-found slot', () => {
  it('VitePress’s 404 while not expired; the message in its place when expired; back again after', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    createApp(theme.Layout).mount(host);
    await nextTick();
    expect([host.querySelector('.vp-404')?.textContent, host.querySelector('.sr-signed-out')]).toEqual(['404', null]);
    expired.value = true;
    await nextTick();
    expect(host.querySelector('.vp-404')).toBeNull();
    expect(host.querySelector('.sr-signed-out h1')?.textContent).toBe('Signed out');
    expired.value = false;
    await nextTick();
    expect(host.querySelector('.vp-404')?.textContent).toBe('404');
  });
});
