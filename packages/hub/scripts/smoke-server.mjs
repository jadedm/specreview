// Live smoke for the hub (loop step 7): the built Worker (dist/index.js) in
// workerd, a fresh in-memory D1 migrated from scratch, a local R2 bucket
// seeded as a publish leaves it, Access's key endpoint and GitHub answered by
// stubs. Nothing leaves the machine. Signed tokens go to .wrangler/smoke/.
//
// pnpm --filter @specreview/hub build
// node packages/hub/scripts/smoke-server.mjs     (then scripts/smoke.sh)
//
// SMOKE_APP=1 (#6) gives the Worker only the GitHub App's secrets, with a
// PKCS#1 key made the way GitHub makes one, and the GitHub stand-in then acts
// as the app's endpoints: it verifies the app JWT, mints tokens for one repo
// and permission, and refuses any other token. Control /app reports them.
//
// The admin page (#56): the Worker has a hub key, and the GitHub stand-in
// answers the app-manifest conversion with an app owned by the smoke org,
// whose endpoints then answer as SMOKE_APP's do. owner@acme.dev is the admin.
//
// Miniflare 4 is pinned: the 5.x alpha under wrangler takes a different
// options shape, and its workerd predates the deploy compatibility date.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { SignJWT, exportJWK, generateKeyPair, importSPKI, jwtVerify } from 'jose';
import { Miniflare } from 'miniflare';

const HUB = path.resolve(import.meta.dirname, '..');
const here = path.join(HUB, '.wrangler/smoke');
mkdirSync(here, { recursive: true });
const TEAM = 'smoke.cloudflareaccess.com';
const AUD = 'aud-smoke';
const PORT = 8797;
// A 48 px grey square as the organisation's logo (#33), stored under its
// content key as deploy would store it.
const LOGO = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAAAAAByaaZbAAAAJ0lEQVR42mO4SyJgGNVAUw3GBMCohlENoxpGNYxqGJkaRmvRAdUAAKGSHUzxrNTPAAAAAElFTkSuQmCC',
  'base64',
);
const LOGO_KEY = `_brand/logo-${createHash('sha256').update(LOGO).digest('hex')}.png`;
const config = {
  org: 'acme',
  brand: { name: 'Acme', logo: { key: LOGO_KEY, type: 'image/png' } },
  accessTeamDomain: TEAM,
  accessAud: AUD,
  admins: ['owner@acme.dev'],
  ownerId: '1001',
  configRepo: 'docs-hub',
  sites: [
    {
      repo: 'sidecar',
      // SMOKE_PUBLIC=1 makes sidecar a public site (#20).
      ...(process.env.SMOKE_PUBLIC === '1' ? { visibility: 'public' } : {}),
      teamDomains: ['acme.dev'],
      approvers: ['pm@acme.dev'],
      readers: ['@initech.example'],
      ticketRepo: 'sidecar',
      branch: 'develop',
      repositoryId: '2001',
      workflow: '.github/workflows/docs.yml',
    },
    {
      repo: 'globex',
      teamDomains: ['globex.dev'],
      approvers: [],
      readers: [],
      ticketRepo: 'globex',
      branch: 'main',
      repositoryId: '2003',
      workflow: '.github/workflows/docs.yml',
    },
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
// When set (control /github-hidden), GitHub answers 404 to everything, as it
// does for a token that cannot see the repo.
let githubHidden = false;

const APP = process.env.SMOKE_APP === '1';
const APP_ID = '424242';
const appKeys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const appPublic = await importSPKI(appKeys.publicKey, 'RS256');
const app = { lookups: 0, mints: [], refused: 0, issued: new Map(), converted: 0 };
const bearer = (req) => req.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
// The app's own endpoints, then the token check on every repo call.
const appAnswer = async (req, url) => {
  const lookup = /^\/repos\/acme\/([^/]+)\/installation$/.exec(url.pathname);
  const mint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname);
  if (lookup || mint) {
    const ok = await jwtVerify(bearer(req), appPublic, { issuer: APP_ID, algorithms: ['RS256'] }).catch(() => null);
    if (!ok) return Response.json({ message: 'A JSON web token could not be decoded' }, { status: 401 });
  }
  if (lookup) {
    app.lookups++;
    return Response.json({ id: 99 });
  }
  if (mint) {
    const body = await req.json();
    app.mints.push(body);
    const token = `ghs_smoke_${randomUUID()}`;
    app.issued.set(token, { repo: body.repositories?.[0], permissions: body.permissions ?? {} });
    return Response.json({ token, expires_at: new Date(Date.now() + 3600_000).toISOString() }, { status: 201 });
  }
  const [, repo, rest = ''] = /^\/repos\/acme\/([^/]+)(\/.*)?$/.exec(url.pathname) ?? [];
  const issued = app.issued.get(bearer(req));
  const allowed =
    issued && issued.repo === repo && neededFor(req.method, rest).every((p) => grants(issued, p, req.method));
  if (allowed) return null;
  app.refused++;
  return Response.json({ message: 'Bad credentials' }, { status: 401 });
};

// What a token must hold per path (#57): Issues for tickets and labels,
// Contents for files and branches (and Workflows for a workflow file), Pull
// requests for pulls.
const neededFor = (method, rest) => {
  if (rest.startsWith('/issues') || rest.startsWith('/labels')) return ['issues'];
  if (rest.startsWith('/pulls')) return ['pull_requests'];
  if (method === 'PUT' && rest.startsWith('/contents/.github/workflows/')) return ['contents', 'workflows'];
  return rest === '' ? [] : ['contents'];
};
const grants = (issued, p, method) =>
  issued.permissions[p] === 'write' || (method === 'GET' && issued.permissions[p] === 'read');

// Two repos for adding a site (#57): newdocs, and docs-hub holding the config.
let shaSeq = 0;
const sha = () => `smokesha${++shaSeq}`;
const repoWith = (id, files) => ({
  id,
  refs: new Map([['main', sha()]]),
  files: new Map([
    [
      'main',
      new Map(Object.entries(files).map(([k, t]) => [k, { sha: sha(), content: Buffer.from(t).toString('base64') }])),
    ],
  ]),
  pulls: [],
});
// The org's file as docs-hub holds it: no Access fields (deploy adds them).
const orgFile = { ...config };
delete orgFile.accessTeamDomain;
delete orgFile.accessAud;
const repoState = {
  newdocs: repoWith(3001, { 'README.md': '# newdocs\n' }),
  'docs-hub': repoWith(4001, {
    'specreview.config.json': `${JSON.stringify({ ...orgFile, brand: { name: 'Acme', logo: 'logo.png' } }, null, 2)}\n`,
  }),
};
const repoApi = async (req, url) => {
  const m = /^\/repos\/acme\/(newdocs|docs-hub)(\/.*)?$/.exec(url.pathname);
  if (!m) return null;
  const r = repoState[m[1]];
  const rest = m[2] ?? '';
  if (rest === '' && req.method === 'GET') return Response.json({ id: r.id, default_branch: 'main' });
  const ref = /^\/git\/ref\/heads\/(.+)$/.exec(rest);
  if (ref)
    return r.refs.has(ref[1])
      ? Response.json({ object: { sha: r.refs.get(ref[1]) } })
      : Response.json({}, { status: 404 });
  if (rest === '/git/refs' && req.method === 'POST') {
    const { ref: name, sha: at } = await req.json();
    const b = name.replace('refs/heads/', '');
    if (r.refs.has(b)) return Response.json({ message: 'Reference already exists' }, { status: 422 });
    r.refs.set(b, at);
    r.files.set(b, new Map(r.files.get('main')));
    return Response.json({ ref: name }, { status: 201 });
  }
  const c = /^\/contents\/(.+)$/.exec(rest);
  if (c && req.method === 'GET') {
    const f = r.files.get(url.searchParams.get('ref') ?? 'main')?.get(c[1]);
    return f ? Response.json(f) : Response.json({}, { status: 404 });
  }
  if (c && req.method === 'PUT') {
    const body = await req.json();
    const files = r.files.get(body.branch);
    if (files.get(c[1])?.sha !== body.sha) return Response.json({ message: 'sha mismatch' }, { status: 409 });
    files.set(c[1], { sha: sha(), content: body.content });
    return Response.json({}, { status: 201 });
  }
  const compare = /^\/compare\/(.+)\.\.\.(.+)$/.exec(rest);
  if (compare && req.method === 'GET') {
    const a = r.files.get(decodeURIComponent(compare[1])) ?? new Map();
    const b = r.files.get(decodeURIComponent(compare[2])) ?? new Map();
    const files = [...new Set([...a.keys(), ...b.keys()])].filter((f) => a.get(f)?.content !== b.get(f)?.content);
    return Response.json({ files: files.map((filename) => ({ filename })) });
  }
  if (rest === '/pulls' && req.method === 'GET') {
    const head = (url.searchParams.get('head') ?? '').split(':')[1];
    return Response.json(r.pulls.filter((p) => p.head === head).map((p) => ({ ...p, base: { ref: p.base } })));
  }
  if (rest === '/pulls' && req.method === 'POST') {
    const body = await req.json();
    const pull = { ...body, html_url: `https://github.com/acme/${m[1]}/pull/${r.pulls.length + 1}` };
    r.pulls.push(pull);
    return Response.json(pull, { status: 201 });
  }
  return null;
};

const github = async (req, url) => {
  if (githubHidden) return Response.json({ message: 'Not Found' }, { status: 404 });
  const converting = /^\/app-manifests\/([^/]+)\/conversions$/.exec(url.pathname);
  if (converting && req.method === 'POST') {
    app.converted++;
    return Response.json(
      {
        id: Number(APP_ID),
        slug: 'specreview-acme',
        pem: appKeys.privateKey,
        owner: { id: 1001, type: 'Organization', login: 'acme' },
      },
      { status: 201 },
    );
  }
  const fromApp = (APP || app.converted > 0) && (await appAnswer(req, url));
  if (fromApp) return fromApp;
  const fromRepos = await repoApi(req, url);
  if (fromRepos) return fromRepos;
  if (/^\/repos\/acme\/[^/]+\/labels/.test(url.pathname)) return Response.json({}, { status: 201 });
  // The cron lists tickets carrying each of our labels; only sidecar has tickets.
  const listing = /^\/repos\/acme\/([^/]+)\/issues$/.exec(url.pathname);
  if (listing && req.method === 'GET') {
    const label = url.searchParams.get('labels');
    const own = listing[1] === 'sidecar' ? [...issues.entries()] : [];
    return Response.json(
      own
        .filter(([, i]) => i.labels.includes(label))
        .map(([number, i]) => ({
          number,
          title: i.title,
          state: i.state,
          html_url: '',
          labels: i.labels.map((name) => ({ name })),
        })),
    );
  }
  if (url.pathname.startsWith('/search/issues')) return Response.json({ total_count: 0, items: [] });
  const m = /^\/repos\/acme\/sidecar\/issues\/(\d+)(\/labels(?:\/(.+))?)?$/.exec(url.pathname);
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
    html_url: `https://github.com/acme/sidecar/issues/${m[1]}`,
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
        SPECREVIEW_KEY: randomBytes(32).toString('base64'),
        SPECREVIEW_COMMIT: 'c'.repeat(40),
        ...(APP
          ? { GITHUB_APP_ID: APP_ID, GITHUB_APP_PRIVATE_KEY: appKeys.privateKey }
          : { GITHUB_READ_TOKEN: 'smoke-read', GITHUB_WRITE_TOKEN: 'smoke-write' }),
      },
      outboundService: async (req) => {
        const url = new URL(req.url);
        if (url.host === TEAM && url.pathname === '/cdn-cgi/access/certs') return Response.json({ keys: [jwk] });
        if (url.host === 'api.github.com') return github(req, url);
        if (url.host === 'token.actions.githubusercontent.com' && url.pathname === '/.well-known/jwks') {
          return Response.json({ keys: [jwk] });
        }
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
// The hub serves an old version only if its bytes hash to the manifest's entry.
const OLD_TEXT = '# Company signup\n\nThe old text.\n';
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
      history: [
        { commit: OLD, path: 'onboarding/signup.md', hash: createHash('sha256').update(OLD_TEXT).digest('hex') },
      ],
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
  [`sidecar/history/${OLD}/onboarding/signup.md`]: OLD_TEXT,
  'sidecar/current.json': JSON.stringify({ version: V, publishedAt: '2026-10-08T00:00:00.000Z' }),
};
for (const [k, v] of Object.entries(files)) await r2.put(k, v);
await r2.put(LOGO_KEY, LOGO);

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
for (const e of [
  'riya@initech.example',
  'dev@acme.dev',
  'pm@acme.dev',
  'owner@acme.dev',
  'x@stranger.example',
  'Riya@INITECH.example',
])
  tokens[e] = await sign(e);
tokens.otherApp = await sign('dev@acme.dev', 'aud-other');
writeFileSync(path.join(here, 'tokens.json'), JSON.stringify(tokens));

// A tiny control port for the smoke: publish V2, read R2/D1/labels, hide the
// ticket repo from the GitHub stand-in, run the cron.
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
    if (url.pathname === '/app')
      return send({ on: APP, converted: app.converted, lookups: app.lookups, mints: app.mints, refused: app.refused });
    if (url.pathname === '/github-hidden') {
      githubHidden = url.searchParams.get('on') === '1';
      return send({ githubHidden });
    }
    if (url.pathname === '/cron') {
      // The cron's own outcome, so a failed run is not reported as a success.
      const ran = await mf
        .getWorker()
        .then((worker) => worker.scheduled({ cron: '*/5 * * * *' }))
        .then(
          (r) => r.outcome,
          (err) => `threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      return send({ outcome: ran });
    }
    if (url.pathname === '/repos') {
      const view = Object.fromEntries(
        Object.entries(repoState).map(([name, r]) => [
          name,
          {
            branches: [...r.refs.keys()],
            work: [...(r.files.get('specreview/add-newdocs')?.keys() ?? [])],
            pulls: r.pulls.map((p) => `${p.head} -> ${p.base}: ${p.title}`),
          },
        ]),
      );
      return send(view);
    }
    if (url.pathname === '/repo-file') {
      const r = repoState[url.searchParams.get('repo')];
      const f = r?.files.get(url.searchParams.get('ref'))?.get(url.searchParams.get('path'));
      return send(f ? Buffer.from(f.content, 'base64').toString('utf8') : null);
    }
    if (url.pathname === '/rows')
      return send((await db.prepare('SELECT site, page, status, version FROM page_status').all()).results);
    res.writeHead(404);
    res.end();
  })
  .listen(PORT + 1, '127.0.0.1');

// A stand-in for the GitHub Actions token endpoint, for the publish smoke:
// GET /token?...&audience=<origin> with "Authorization: bearer smoke" answers
// a token for sidecar's docs workflow on develop, as a push. The commit comes
// from the file in SMOKE_SHA_FILE, read on every request; run ids count up.
let runId = 500;
http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/token' || req.headers.authorization !== 'bearer smoke') {
      res.writeHead(401);
      return res.end();
    }
    const sha = readFileSync(process.env.SMOKE_SHA_FILE ?? '/dev/null', 'utf8').trim();
    const value = await new SignJWT({
      repository: 'acme/sidecar',
      repository_id: '2001',
      repository_owner_id: '1001',
      workflow_ref: 'acme/sidecar/.github/workflows/docs.yml@refs/heads/develop',
      ref: 'refs/heads/develop',
      event_name: 'push',
      sha,
      run_id: String(++runId),
      run_attempt: '1',
      jti: randomUUID(),
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'smoke' })
      .setIssuer('https://token.actions.githubusercontent.com')
      .setAudience(url.searchParams.get('audience') ?? '')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(keys.privateKey);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ value }));
  })
  .listen(PORT + 2, '127.0.0.1');

// A stand-in for Access in front of the Worker, for a browser: /__smoke/login?email=
// sets a cookie, and every other request is forwarded with a token for that
// email, as Access does. No cookie is a 302 to a login page, as Access does.
// With SMOKE_PUBLIC=1, sidecar's pages are bypassed as Access bypasses them:
// forwarded with no token, signed in or not; its _api, _history and _signin
// stay behind the stand-in.
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
    const bypassed =
      process.env.SMOKE_PUBLIC === '1' &&
      url.pathname.startsWith('/sidecar/') &&
      !/^\/sidecar\/(_api|_history|_signin)(\/|$)/.test(url.pathname);
    if (!cookie && !bypassed) {
      res.writeHead(302, { location: `https://${TEAM}/cdn-cgi/access/login` });
      return res.end();
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const headers = bypassed
      ? { ...req.headers }
      : { ...req.headers, 'cf-access-jwt-assertion': await sign(decodeURIComponent(cookie[1])) };
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
