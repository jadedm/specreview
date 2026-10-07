// Placeholder until #3 ports the sidecar docs Worker: everything is 404.
export default {
  fetch: (_request, _env, _ctx) =>
    new Response(JSON.stringify({ error: { code: 'NOT_FOUND' } }), {
      status: 404,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    }),
} satisfies ExportedHandler;
