// #132: an error thrown while VitePress renders a page on the server (in a
// component's setup or render; an async setup's rejection is dropped by Vue's
// server renderer before anything here sees it) fails the build and names the page. Vue in production only logs such an error (the page
// would be published missing whatever failed), and VitePress does not say
// which page it was rendering. An error-captured hook on the layout runs
// outside Vue's error handling, so what it throws ends the render.
import { useRoute } from 'vitepress';
import { defineComponent, onErrorCaptured } from 'vue';

const onServer = () => typeof window === 'undefined';

const labelled = new WeakSet<object>();

// Called in the layout's setup.
export const failRenderOnError = () => {
  if (!onServer()) return;
  const route = useRoute();
  onErrorCaptured((err) => {
    // The labelled error passes this hook again on its way out: once is enough.
    if (labelled.has(err)) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const out = new Error(`while rendering ${route.path}: ${message}`, { cause: err });
    // The build prints the stack alone: keep the failing component's frames.
    if (err instanceof Error && err.stack)
      out.stack = `Error: ${out.message}\n${err.stack.split('\n').slice(1).join('\n')}`;
    labelled.add(out);
    throw out;
  });
};

// The build test's way in (test/build.test.ts): on the server only, the page
// whose path is SPECREVIEW_RENDER_ERROR_FOR_TESTS throws while rendering.
const testPath = () =>
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env
    .SPECREVIEW_RENDER_ERROR_FOR_TESTS;
export const RenderErrorForTests = defineComponent({
  name: 'RenderErrorForTests',
  setup() {
    const route = useRoute();
    if (onServer() && testPath() !== undefined && testPath() === route.path)
      throw new Error('a render error the build test asked for');
    return () => null;
  },
});
