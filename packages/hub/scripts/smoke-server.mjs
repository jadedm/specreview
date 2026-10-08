// Live smoke for the hub (loop step 7): the built Worker (dist/index.js) in
// workerd, a fresh in-memory D1 migrated from scratch, a local R2 bucket
// seeded as a publish leaves it, Access's key endpoint and GitHub answered by
// stubs. Nothing leaves the machine. Signed tokens go to .wrangler/smoke/.
//
// pnpm --filter @specreview/hub build
// node packages/hub/scripts/smoke-server.mjs     (then scripts/smoke.sh)
//
// Miniflare 4 is pinned: the 5.x alpha under wrangler takes a different
// options shape, and its workerd predates the deploy compatibility date.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { Miniflare } from 'miniflare';

const HUB = path.resolve(import.meta.dirname, '..');
const here = path.join(HUB, '.wrangler/smoke');
mkdirSync(here, { recursive: true });
const TEAM = 'smoke.cloudflareaccess.com';
const AUD = 'aud-smoke';
const PORT = 8797;
const config = {
  org: 'inoltrotech',
  accessTeamDomain: TEAM,
  accessAud: AUD,
  admins: ['owner@inoltro.ai'],
  sites: [
    {
      repo: 'sidecar',
      teamDomains: ['inoltro.ai'],
      approvers: ['pm@inoltro.ai'],
      readers: ['@ariai.example'],
      ticketRepo: 'sidecar',
    },
    { repo: 'tikiti', teamDomains: ['tikiti.live'], approvers: [], readers: [], ticketRepo: 'tikiti' },
  ],
};

const keys = await generateKeyPair('RS256', { extractable: true });
const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'smoke', alg: 'RS256', use: 'sig' };
const sign = (email, aud = AUD) =>
  new SignJWT({ email })
    .setProtectedHeader({ alg: 'RS256', kid: 'smoke' })
    .setIssuer(`https://${TEAM}`)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime('30m')
    .sign(keys.privateKey);

const issues = new Map([[52, { title: 'Company approval', state: 'open', labels: [] }]]);
const github = async (req, url) => {
  if (/^\/repos\/inoltrotech\/sidecar\/labels/.test(url.pathname)) return Response.json({}, { status: 201 });
  if (url.pathname.startsWith('/search/issues')) return Response.json({ total_count: 0, items: [] });
  const m = /^\/repos\/inoltrotech\/sidecar\/issues\/(\d+)(\/labels(?:\/(.+))?)?$/.exec(url.pathname);
  const issue = m && issues.get(Number(m[1]));
  if (!issue) return Response.json({ message: 'Not Found' }, { status: 404 });
  if (req.method === 'PUT' && m[2]) issue.labels = (await req.json()).labels;
  if (req.method === 'POST' && m[2])
    for (const l of (await req.json()).labels) if (!issue.labels.includes(l)) issue.labels.push(l);
  if (req.method === 'DELETE' && m[3]) issue.labels = issue.labels.filter((l) => l !== decodeURIComponent(m[3]));
  return Response.json({
    number: Number(m[1]),
    title: issue.title,
    state: issue.state,
    html_url: `https://github.com/inoltrotech/sidecar/issues/${m[1]}`,
    labels: issue.labels.map((name) => ({ name })),
  });
};

const mf = new Miniflare({
  host: '127.0.0.1',
  port: PORT,
  workers: [
    {
      name: 'hub-smoke',
      modules: true,
      scriptPath: path.join(HUB, 'dist/index.js'),
      modulesRoot: path.join(HUB, 'dist'),
      compatibilityDate: '2026-07-30',
      d1Databases: ['DB'],
      r2Buckets: ['SITES'],
      bindings: {
        SPECREVIEW_CONFIG: JSON.stringify(config),
        GITHUB_READ_TOKEN: 'smoke-read',
        GITHUB_WRITE_TOKEN: 'smoke-write',
      },
      outboundService: async (req) => {
        const url = new URL(req.url);
        if (url.host === TEAM && url.pathname === '/cdn-cgi/access/certs') return Response.json({ keys: [jwk] });
        if (url.host === 'api.github.com') return github(req, url);
        return new Response(`smoke: outbound call to ${url.host} refused`, { status: 599 });
      },
    },
  ],
});
await mf.ready;

const db = await mf.getD1Database('DB');
for (const file of readdirSync(path.join(HUB, 'migrations')).sort()) {
  const sql = readFileSync(path.join(HUB, 'migrations', file), 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
  for (const s of sql
    .split(';')
    .map((x) => x.trim())
    .filter(Boolean))
    await db.prepare(s).run();
}

const r2 = await mf.getR2Bucket('SITES');
const V = `${'b'.repeat(40)}-101`;
const OLD = 'a'.repeat(40);
const manifest = {
  commit: 'b'.repeat(40),
  builtAt: '2026-10-08T00:00:00.000Z',
  csp: "default-src 'self'; img-src 'self' data:",
  pages: {
    index: { title: 'sidecar docs', hash: 'h-index', issues: [], sections: [], history: [] },
    'onboarding/signup': {
      title: 'Company signup',
      hash: 'h-signup',
      issues: [52],
      sections: [{ id: 'who', title: 'Who', text: 'Any signed-in admin can create a company.' }],
      history: [{ commit: OLD, path: 'onboarding/signup.md', hash: 'h-old' }],
    },
  },
};
const files = {
  [`sidecar/v/${V}/manifest.json`]: JSON.stringify(manifest),
  [`sidecar/v/${V}/index.html`]: '<!doctype html><title>sidecar docs</title><h1>sidecar docs</h1>',
  [`sidecar/v/${V}/onboarding/signup.html`]: '<!doctype html><title>Company signup</title><h1>Company signup</h1>',
  [`sidecar/v/${V}/guide/index.html`]: '<!doctype html><title>Guide</title>',
  [`sidecar/v/${V}/assets/app.js`]: 'console.log("app")',
  [`sidecar/v/${V}/assets/logo.svg`]: '<svg xmlns="http://www.w3.org/2000/svg"/>',
  [`sidecar/v/${V}/files/report.bin`]: 'binary',
  [`sidecar/v/${V}/release-1.2.html`]: '<!doctype html><title>Release 1.2</title>',
  [`sidecar/history/${OLD}/onboarding/signup.md`]: '# Company signup\n\nThe old text.\n',
  'sidecar/current.json': JSON.stringify({ version: V, publishedAt: '2026-10-08T00:00:00.000Z' }),
};
for (const [k, v] of Object.entries(files)) await r2.put(k, v);

// SMOKE_SITE=<out of specreview-site build --repo sidecar>: publish that real
// build as sidecar's current version instead of the hand-written pages.
const walk = (dir) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => path.relative(dir, path.join(d.parentPath, d.name)).split(path.sep).join('/'));
if (process.env.SMOKE_SITE) {
  const out = path.resolve(process.env.SMOKE_SITE);
  const built = JSON.parse(readFileSync(path.join(out, 'site', 'manifest.json'), 'utf8'));
  const version = `${built.commit}-301`;
  for (const f of walk(path.join(out, 'site')))
    await r2.put(`sidecar/v/${version}/${f}`, readFileSync(path.join(out, 'site', f)));
  for (const f of walk(path.join(out, 'history')))
    await r2.put(`sidecar/history/${f}`, readFileSync(path.join(out, 'history', f)));
  await r2.put('sidecar/current.json', JSON.stringify({ version, publishedAt: new Date().toISOString() }));
  console.log(`published ${out} as sidecar ${version}`);
}

const tokens = {};
for (const e of ['riya@ariai.example', 'dev@inoltro.ai', 'pm@inoltro.ai', 'x@stranger.example', 'Riya@ARIAI.example'])
  tokens[e] = await sign(e);
tokens.otherApp = await sign('dev@inoltro.ai', 'aud-other');
writeFileSync(path.join(here, 'tokens.json'), JSON.stringify(tokens));

// A tiny control port for the smoke: publish V2, read R2/D1/labels.
http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (body) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/publish-v2') {
      const V2 = `${'c'.repeat(40)}-102`;
      await r2.put(`sidecar/v/${V2}/manifest.json`, JSON.stringify(manifest));
      await r2.put(`sidecar/v/${V2}/onboarding/signup.html`, '<!doctype html><title>Company signup v2</title>');
      await r2.put('sidecar/current.json', JSON.stringify({ version: V2, publishedAt: '2026-10-08T01:00:00.000Z' }));
      return send({ published: V2 });
    }
    if (url.pathname === '/break-pointer') {
      await r2.put('sidecar/current.json', '{"version":"../x","publishedAt":"x"}');
      return send({ ok: true });
    }
    if (url.pathname === '/labels') return send(issues.get(52).labels);
    if (url.pathname === '/rows')
      return send((await db.prepare('SELECT site, page, status, version FROM page_status').all()).results);
    res.writeHead(404);
    res.end();
  })
  .listen(PORT + 1, '127.0.0.1');

// A stand-in for Access in front of the Worker, for a browser: /__smoke/login?email=
// sets a cookie, and every other request is forwarded with a token for that
// email, as Access does. No cookie is a 302 to a login page, as Access does.
const PROXY = PORT - 1;
http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/__smoke/login') {
      const email = url.searchParams.get('email') ?? '';
      res.writeHead(302, {
        'set-cookie': `smoke_as=${encodeURIComponent(email)}; Path=/; HttpOnly`,
        location: '/sidecar/',
      });
      return res.end();
    }
    const cookie = /(?:^|;\s*)smoke_as=([^;]+)/.exec(req.headers.cookie ?? '');
    if (!cookie) {
      res.writeHead(302, { location: `https://${TEAM}/cdn-cgi/access/login` });
      return res.end();
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const headers = { ...req.headers, 'cf-access-jwt-assertion': await sign(decodeURIComponent(cookie[1])) };
    const upstream = http.request(
      { host: '127.0.0.1', port: PORT, path: req.url, method: req.method, headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => {
      res.writeHead(502);
      res.end('smoke proxy: worker unreachable');
    });
    upstream.end(Buffer.concat(chunks));
  })
  .listen(PROXY, '127.0.0.1');

console.log(
  `smoke ready: worker http://127.0.0.1:${PORT}, control http://127.0.0.1:${PORT + 1}, browser http://127.0.0.1:${PROXY}`,
);
const stop = async () => {
  await mf.dispose();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
