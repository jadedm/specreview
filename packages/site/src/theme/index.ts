import type { Theme } from 'vitepress';
// Without fonts: the house style uses the system font, so Inter is neither
// bundled nor fetched.
import DefaultTheme from 'vitepress/theme-without-fonts';
import { h } from 'vue';
import { OrgBrand } from './brand';
import { BOTTOM_MOUNT, TOP_MOUNT, startReview } from './review/start';
import './house.css';
import './review/review.css';

// The review UI lives in two empty containers the layout renders around the
// page. Vue never gives them children, so it leaves what the review code puts
// there alone; the page text itself stays Vue's.
export default {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      'nav-bar-content-after': () => h(OrgBrand),
      'doc-before': () => h('div', { id: TOP_MOUNT }),
      'doc-after': () => h('div', { id: BOTTOM_MOUNT }),
    }),
  enhanceApp({ router, siteData }) {
    if (typeof window === 'undefined') return;
    // Every API and history path is under the site's base, /<repo>/.
    startReview(router, siteData.value.base);
  },
} satisfies Theme;
