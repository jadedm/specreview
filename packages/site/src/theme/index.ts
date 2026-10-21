import type { Theme } from 'vitepress';
// Without fonts: the house style uses the system font, so Inter is neither
// bundled nor fetched.
import DefaultTheme from 'vitepress/theme-without-fonts';
import { defineComponent, h } from 'vue';
import { OrgBrand } from './brand';
import { Diagrams } from './diagrams';
import { Highlights } from './review/highlights';
import { BOTTOM_MOUNT, TOP_MOUNT, startReview } from './review/start';
import { failRenderOnError, RenderErrorForTests } from './render-errors';
import { expired, SignedOutMessage, SignedOutProbe } from './signed-out';
import './house.css';
import './review/review.css';

// The review UI lives in two empty containers the layout renders around the
// page. Vue never gives them children, so it leaves what the review code puts
// there alone; the page text itself stays Vue's.
export default {
  extends: DefaultTheme,
  Layout: defineComponent({
    name: 'SpecreviewLayout',
    setup() {
      // #132: a render error on the server fails the build, naming the page.
      failRenderOnError();
      return () =>
        h(DefaultTheme.Layout, null, {
          'nav-bar-content-after': () => h(OrgBrand),
          'doc-before': () => h('div', { id: TOP_MOUNT }),
          'doc-after': () => [h('div', { id: BOTTOM_MOUNT }), h(Diagrams), h(Highlights)],
          // #123: a 404 shown because the sign-in expired says so.
          'layout-bottom': () => [h(SignedOutProbe), h(RenderErrorForTests)],
          ...(expired.value ? { 'not-found': () => h(SignedOutMessage) } : {}),
        });
    },
  }),
  enhanceApp({ app, router, siteData }) {
    // On the server render (#132): an error while rendering a page fails the
    // build. Vue's default in production only logs it, and the page would be
    // published missing whatever failed. Browsers keep the default.
    if (typeof window === 'undefined') {
      app.config.throwUnhandledErrorInProduction = true;
      return;
    }
    // Every API and history path is under the site's base, /<repo>/.
    startReview(router, siteData.value.base);
  },
} satisfies Theme;
