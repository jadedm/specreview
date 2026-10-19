// #132: the server render rethrows errors so the build fails; the browser
// keeps Vue's default. Vitest runs this file in Node, where there is no window.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vitepress/theme-without-fonts', () => ({ default: { Layout: () => null } }));
vi.mock('vitepress', () => ({ useData: () => ({}), useRoute: () => ({}) }));
const start = vi.fn();
vi.mock('./review/start', () => ({ BOTTOM_MOUNT: 'b', TOP_MOUNT: 't', startReview: start, SIGNED_OUT_TEXT: 'x' }));
const theme = (await import('./index')).default;

const context = () => {
  const app = { config: {} as { throwUnhandledErrorInProduction?: boolean } };
  return { app, router: {}, siteData: { value: { base: '/s/' } } };
};

afterEach(() => vi.unstubAllGlobals());

describe('132: errors during the server render', () => {
  it('1: with no window, Vue is told to throw rendering errors (the build test shows one failing the build)', () => {
    const ctx = context();
    theme.enhanceApp(ctx as never);
    expect(ctx.app.config.throwUnhandledErrorInProduction).toBe(true);
    expect(start).not.toHaveBeenCalled();
  });

  it('2: in a browser, Vue keeps its default and the review UI starts', () => {
    vi.stubGlobal('window', {});
    const ctx = context();
    theme.enhanceApp(ctx as never);
    expect(ctx.app.config.throwUnhandledErrorInProduction).toBeUndefined();
    expect(start).toHaveBeenCalledWith({}, '/s/');
  });
});
