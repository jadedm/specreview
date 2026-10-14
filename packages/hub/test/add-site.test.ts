import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import example from '../../../examples/publish-docs.yml?raw';
import { workflowFor } from '../src/add-site';
import { problemsIn } from '../src/config';
import { appStub, call, CONFIG, github, HOST, installFetch, reset } from './helpers';

// Adding a site from the admin page (#57), against a stand-in GitHub that
// keeps repos, branches, files and pull requests in memory.
const ADMIN = 'owner@acme.dev';
const COMMIT = 'c'.repeat(40);
const APP_ID = '424242';
const keys = (await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true,
  ['sign', 'verify'],
)) as CryptoKeyPair;
const pkcs8 = new Uint8Array((await crypto.subtle.exportKey('pkcs8', keys.privateKey)) as ArrayBuffer);
const PEM = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs8))
  .match(/.{1,64}/g)!
  .join('\n')}\n-----END PRIVATE KEY-----\n`;

// The org's config as it sits in docs-hub (no Access fields; deploy adds them).
const { accessTeamDomain: _t, accessAud: _a, ...orgFile } = CONFIG as Record<string, unknown>;
const HUB_CONFIG = { ...CONFIG, configRepo: 'docs-hub' };
const env = {
  SPECREVIEW_CONFIG: JSON.stringify(HUB_CONFIG),
  SPECREVIEW_COMMIT: COMMIT,
  GITHUB_APP_ID: APP_ID,
  GITHUB_APP_PRIVATE_KEY: PEM,
};

type File = { sha: string; content: string };
type Pull = { head: string; base: string; title: string; body: string; html_url: string };
type Repo = {
  id: number;
  default: string;
  refs: Map<string, string>;
  files: Map<string, Map<string, File>>;
  pulls: Pull[];
};
const b64 = (t: string) => btoa(String.fromCharCode(...new TextEncoder().encode(t)));
const text = (f: File) => new TextDecoder().decode(Uint8Array.from(atob(f.content), (c) => c.charCodeAt(0)));
let shaSeq = 0;
const sha = () => `sha${++shaSeq}`;

const repoWith = (id: number, files: Record<string, string>): Repo => {
  const main = new Map(Object.entries(files).map(([p, t]) => [p, { sha: sha(), content: b64(t) }]));
  return { id, default: 'main', refs: new Map([['main', sha()]]), files: new Map([['main', main]]), pulls: [] };
};

let repos: Map<string, Repo>;
let fail: string | null;
const calls: string[] = [];

const standIn = async (req: Request, repoName: string, path: string): Promise<Response | null> => {
  const repo = repos.get(repoName);
  if (!repo) return Response.json({ message: 'Not Found' }, { status: 404 });
  const u = new URL(`http://x${path || '/'}`);
  const key = `${req.method} ${u.pathname}@${repoName}`;
  calls.push(key);
  if (fail && key.startsWith(fail)) return Response.json({ message: 'boom' }, { status: 500 });
  if (u.pathname === '/' && req.method === 'GET') return Response.json({ id: repo.id, default_branch: repo.default });
  const ref = /^\/git\/ref\/heads\/(.+)$/.exec(u.pathname);
  if (ref) {
    const head = repo.refs.get(ref[1]);
    return head ? Response.json({ object: { sha: head } }) : Response.json({ message: 'Not Found' }, { status: 404 });
  }
  if (u.pathname === '/git/refs' && req.method === 'POST') {
    const { ref: name, sha: at } = (await req.json()) as { ref: string; sha: string };
    const branch = name.replace('refs/heads/', '');
    if (repo.refs.has(branch)) return Response.json({ message: 'Reference already exists' }, { status: 422 });
    const from = [...repo.refs.entries()].find(([, s]) => s === at)?.[0] ?? repo.default;
    repo.refs.set(branch, at);
    repo.files.set(branch, new Map(repo.files.get(from)));
    return Response.json({ ref: name }, { status: 201 });
  }
  const content = /^\/contents\/(.+)$/.exec(u.pathname);
  if (content && req.method === 'GET') {
    const f = repo.files.get(u.searchParams.get('ref') ?? repo.default)?.get(content[1]);
    return f ? Response.json(f) : Response.json({ message: 'Not Found' }, { status: 404 });
  }
  if (content && req.method === 'PUT') {
    const body = (await req.json()) as { content: string; branch: string; sha?: string };
    const files = repo.files.get(body.branch);
    if (!files) return Response.json({ message: 'No branch' }, { status: 404 });
    const existing = files.get(content[1]);
    if (existing?.sha !== body.sha) return Response.json({ message: 'sha mismatch' }, { status: 409 });
    files.set(content[1], { sha: sha(), content: body.content });
    return Response.json({}, { status: existing ? 200 : 201 });
  }
  if (u.pathname === '/branches' && req.method === 'GET') {
    const per = Math.min(100, Number(u.searchParams.get('per_page') ?? '30'));
    const page = Number(u.searchParams.get('page') ?? '1');
    const names = [...repo.refs.keys()].sort();
    return Response.json(names.slice((page - 1) * per, page * per).map((name) => ({ name })));
  }
  const compare = /^\/compare\/(.+)\.\.\.(.+)$/.exec(u.pathname);
  if (compare && req.method === 'GET') {
    const [base, head] = [decodeURIComponent(compare[1]), decodeURIComponent(compare[2])];
    const a = repo.files.get(base) ?? new Map<string, File>();
    const b = repo.files.get(head) ?? new Map<string, File>();
    const changed = [...new Set([...a.keys(), ...b.keys()])].filter((f) => a.get(f)?.content !== b.get(f)?.content);
    return Response.json({ files: changed.map((filename) => ({ filename })) });
  }
  if (u.pathname === '/pulls' && req.method === 'GET') {
    const head = (u.searchParams.get('head') ?? '').split(':')[1];
    return Response.json(repo.pulls.filter((p) => p.head === head).map((p) => ({ ...p, base: { ref: p.base } })));
  }
  if (u.pathname === '/pulls' && req.method === 'POST') {
    const body = (await req.json()) as Omit<Pull, 'html_url'>;
    const pull = { ...body, html_url: `https://github.com/${repoName}/pull/${repo.pulls.length + 1}` };
    repo.pulls.push(pull);
    return Response.json(pull, { status: 201 });
  }
  return null;
};

let spy: ReturnType<typeof installFetch>;
beforeEach(async () => {
  spy = installFetch();
  await reset();
  repos = new Map([
    ['acme/newdocs', repoWith(3001, { 'README.md': '# newdocs\n' })],
    ['acme/docs-hub', repoWith(4001, { 'specreview.config.json': `${JSON.stringify(orgFile, null, 2)}\n` })],
  ]);
  fail = null;
  calls.length = 0;
  github.repoApi = standIn;
  github.app = appStub(APP_ID, keys.publicKey);
  for (const r of ['acme/newdocs', 'acme/docs-hub']) github.app.installations.set(r, 7);
});
afterEach(() => {
  spy.mockRestore();
  vi.restoreAllMocks();
});

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
const add = (
  fields: Record<string, string>,
  opts: { email?: string; origin?: string | null; envOverride?: Record<string, string | undefined> } = {},
) =>
  call('/_admin/sites', {
    raw: true,
    method: 'POST',
    email: opts.email ?? ADMIN,
    envOverride: opts.envOverride ?? env,
    rawBody: form(fields),
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(opts.origin === null ? {} : { origin: opts.origin ?? HOST }),
    },
  });
const html = (r: { body: unknown }) => r.body as unknown as string;
const NEW = { repo: 'newdocs', branch: '', docs: 'docs', ticketRepo: '', teamDomain: 'acme.dev' };
const fileOn = (repo: string, branch: string, path: string) => repos.get(repo)!.files.get(branch)?.get(path);

describe('1 to 3: who and when', () => {
  it('1: a non-admin, another origin and the opaque null origin are refused with no GitHub call', async () => {
    expect((await add(NEW, { email: 'dev@acme.dev' })).status).toBe(403);
    expect((await add(NEW, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await add(NEW, { origin: 'null' })).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it.each([
    ['no configRepo', { SPECREVIEW_CONFIG: JSON.stringify(CONFIG) }, 'configRepo', 'does not know its config repo'],
    ['no specreview commit', { SPECREVIEW_COMMIT: undefined }, 'specreview.commit', 'its specreview commit'],
    [
      'no app',
      { GITHUB_APP_ID: undefined, GITHUB_APP_PRIVATE_KEY: undefined },
      'a GitHub App',
      'the hub has no GitHub App',
    ],
  ])(
    '2 and 3: %s: the page says what is missing and has no form; a post is refused',
    async (_n, change, word, refusal) => {
      const e = { ...env, ...change };
      const page = html(await call('/_admin/', { raw: true, email: ADMIN, envOverride: e }));
      expect(page).toContain(word);
      expect(page).not.toContain('action="/_admin/sites"');
      const r = await add(NEW, { envOverride: e });
      expect(r.status).toBe(409);
      expect(html(r)).toContain(refusal);
      expect(calls).toEqual([]);
    },
  );

  it('the page starts the add-site form when all is there; step 2 fills in the docs folder', async () => {
    const page = html(await call('/_admin/', { raw: true, email: ADMIN, envOverride: env }));
    expect(page).toContain('<form method="get" action="/_admin/">');
    const step2 = html(await call('/_admin/?repo=newdocs', { raw: true, email: ADMIN, envOverride: env }));
    expect(step2).toContain('<form method="post" action="/_admin/sites">');
    expect(step2).toContain('name="docs" value="docs"');
  });
});

describe('4 to 8: refused before anything is written', () => {
  it.each([
    [{ repo: 'Bad Name' }, 'repo:'],
    [{ repo: '_hidden' }, 'repo:'],
    [{ branch: '../main' }, 'branch:'],
    [{ branch: 'a//b' }, 'branch:'],
    [{ docs: '../etc' }, 'docs folder:'],
    [{ docs: '/abs' }, 'docs folder:'],
    [{ ticketRepo: 'no/slash' }, 'ticket repo:'],
    [{ teamDomain: 'Not A Domain!' }, 'team domain:'],
    [{ repo: 'docs-hub' }, 'cannot be a docs site'],
  ])('4: %o is refused naming the field', async (change, word) => {
    const r = await add({ ...NEW, ...change });
    expect(r.status).toBe(400);
    expect(html(r)).toContain(word);
    expect(calls).toEqual([]);
  });

  it('5: a repo that is already a site is refused', async () => {
    const r = await add({ ...NEW, repo: 'sidecar' });
    expect(r.status).toBe(409);
    expect(html(r)).toContain('sidecar is already a site');
  });

  it('6: the app not installed on the product repo or the config repo is refused, naming it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    github.app!.installations.delete('acme/docs-hub');
    const r = await add(NEW);
    expect(r.status).toBe(409);
    expect(html(r)).toContain('the app is not installed on acme/docs-hub');
    expect(calls).toEqual([]);
  });

  it('7: an app without the new permissions is told so, and nothing is written', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    github.app!.granted = { issues: 'write', metadata: 'read' };
    const r = await add(NEW);
    expect(r.status).toBe(409);
    expect(html(r)).toContain('lacks Contents, Pull requests or Workflows write');
    expect(calls).toEqual([]);
  });

  it('8: a repo or branch GitHub does not have is refused', async () => {
    repos.delete('acme/newdocs');
    expect(html(await add(NEW))).toContain('acme/newdocs was not found');
    repos.set('acme/newdocs', repoWith(3001, {}));
    const r = await add({ ...NEW, branch: 'release' });
    expect(r.status).toBe(400);
    expect(html(r)).toContain('acme/newdocs has no branch release');
    expect([...repos.get('acme/newdocs')!.refs.keys()]).toEqual(['main']);
  });

  it('a config that would be invalid is refused before any branch exists', async () => {
    const r = await add({ ...NEW, teamDomain: 'gmail.com' });
    expect(r.status).toBe(400);
    expect(html(r)).toContain('the config would not be valid');
    expect(calls.some((c) => c.startsWith('POST'))).toBe(false);
  });
});

describe('9, 10 and 12: the pull requests', () => {
  it('9: opens both, with the exact workflow, a first page, and the site in the config', async () => {
    const r = await add(NEW);
    expect(r.status).toBe(200);
    const page = html(r);
    expect(page).toContain('https://github.com/acme/docs-hub/pull/1');
    expect(page).toContain('https://github.com/acme/newdocs/pull/1');
    expect(page).toMatch(
      /Merge .*docs-hub\/pull\/1.* and wait for the apply workflow to finish green.*Then merge .*newdocs\/pull\/1/s,
    );

    const work = 'specreview/add-newdocs';
    const wf = text(fileOn('acme/newdocs', work, '.github/workflows/docs.yml')!);
    expect(wf).toBe(workflowFor({ ...NEW, ticketRepo: 'newdocs' }, 'main', HOST, COMMIT));
    expect(wf.match(new RegExp(`jadedm/specreview/(build|publish)@${COMMIT}`, 'g'))).toHaveLength(2);
    expect(wf).toContain(`hub: ${HOST}`);
    expect(wf).toContain('branches: ["main"]');
    expect(text(fileOn('acme/newdocs', work, 'docs/index.md')!)).toMatch(/^# newdocs\n/);

    const cfg = JSON.parse(text(fileOn('acme/docs-hub', work, 'specreview.config.json')!)) as {
      sites: Record<string, unknown>[];
    };
    expect(cfg.sites.at(-1)).toEqual({
      repo: 'newdocs',
      teamDomains: ['acme.dev'],
      approvers: [],
      readers: [],
      ticketRepo: 'newdocs',
      branch: 'main',
      repositoryId: '3001',
      workflow: '.github/workflows/docs.yml',
    });
    expect(problemsIn({ ...cfg, accessTeamDomain: CONFIG.accessTeamDomain, accessAud: CONFIG.accessAud })).toEqual([]);
    expect(fileOn('acme/docs-hub', 'main', 'specreview.config.json')).toEqual(
      repos.get('acme/docs-hub')!.files.get('main')!.get('specreview.config.json'),
    );

    const [cfgPull] = repos.get('acme/docs-hub')!.pulls;
    const [docsPull] = repos.get('acme/newdocs')!.pulls;
    expect([cfgPull.head, cfgPull.base, docsPull.head, docsPull.base]).toEqual([work, 'main', work, 'main']);
    expect(cfgPull.body).toContain('wait for the apply workflow to finish green');
    expect(docsPull.body).toContain(cfgPull.html_url);
    expect(docsPull.body).toContain('wait for its apply workflow to finish green, then merge this');
    expect(docsPull.body).toContain('re-run it once the hub is deployed');
  });

  it('9: an existing first page is left alone; a chosen branch, folder and ticket repo are used', async () => {
    repos.set('acme/newdocs', repoWith(3001, { 'handbook/index.md': '# Ours\n' }));
    repos.get('acme/newdocs')!.refs.set('develop', 'devsha');
    repos.get('acme/newdocs')!.files.set('develop', new Map(repos.get('acme/newdocs')!.files.get('main')));
    const r = await add({ ...NEW, branch: 'develop', docs: 'handbook', ticketRepo: 'sidecar' });
    expect(r.status).toBe(200);
    const work = 'specreview/add-newdocs';
    expect(text(fileOn('acme/newdocs', work, 'handbook/index.md')!)).toBe('# Ours\n');
    expect(text(fileOn('acme/newdocs', work, '.github/workflows/docs.yml')!)).toContain('docs: "handbook"');
    expect(repos.get('acme/newdocs')!.pulls[0].base).toBe('develop');
    const cfg = JSON.parse(text(fileOn('acme/docs-hub', work, 'specreview.config.json')!)) as {
      sites: { ticketRepo: string; branch: string }[];
    };
    expect(cfg.sites.at(-1)).toMatchObject({ ticketRepo: 'sidecar', branch: 'develop' });
  });

  it('10: adding again reuses the branches and pull requests, and writes nothing new', async () => {
    expect((await add(NEW)).status).toBe(200);
    const writes = calls.filter((c) => !c.startsWith('GET')).length;
    expect((await add(NEW)).status).toBe(200);
    expect(calls.filter((c) => !c.startsWith('GET')).length - writes).toBe(2);
    expect(repos.get('acme/docs-hub')!.pulls).toHaveLength(1);
    expect(repos.get('acme/newdocs')!.pulls).toHaveLength(1);
  });

  it('12: each repo gets a token for itself alone with only what it needs', async () => {
    await add(NEW);
    const setup = github.app!.mints.map(
      (m) => m.body as { repositories: string[]; permissions: Record<string, string> },
    );
    expect(setup).toContainEqual({
      repositories: ['newdocs'],
      permissions: { contents: 'write', pull_requests: 'write', workflows: 'write' },
    });
    expect(setup).toContainEqual({
      repositories: ['docs-hub'],
      permissions: { contents: 'write', pull_requests: 'write' },
    });
    expect(setup.every((m) => m.repositories.length === 1)).toBe(true);
  });
});

describe('11: GitHub failing part way', () => {
  it('says which step, lists what was made, and a second try finishes', async () => {
    fail = 'POST /pulls@acme/newdocs';
    const r = await add(NEW);
    expect(r.status).toBe(502);
    const page = html(r);
    expect(page).toContain('opening the pull request on acme/newdocs: GitHub answered 500');
    expect(page).toContain('https://github.com/acme/docs-hub/pull/1');
    expect(page).toContain('the branch and any open pull request are reused');
    fail = null;
    expect((await add(NEW)).status).toBe(200);
    expect(repos.get('acme/docs-hub')!.pulls).toHaveLength(1);
    expect(repos.get('acme/newdocs')!.pulls).toHaveLength(1);
  });
});

describe('the review fixes', () => {
  const work = 'specreview/add-newdocs';

  it('the workflow is the publish example with this site filled in, line for line', async () => {
    await add(NEW);
    const code = (t: string) =>
      t
        .split('\n')
        .filter((l) => l.trim() && !l.trim().startsWith('#'))
        .map((l) => l.replace(/\s+#.*$/, ''));
    const expected = code(example).map((l) =>
      l
        .replace('branches: [develop]', 'branches: ["main"]')
        .replace('repo: sidecar', 'repo: "newdocs"')
        .replace('hub: https://docs.example.com', `hub: ${HOST}`)
        .replace('<specreview-commit>', COMMIT),
    );
    const got = code(text(fileOn('acme/newdocs', work, '.github/workflows/docs.yml')!));
    // The one line the example lacks: the docs input, right after the build's repo.
    const at = got.findIndex((l) => l === '          docs: "docs"');
    expect(got[at - 1]).toBe('          repo: "newdocs"');
    got.splice(at, 1);
    expect(got).toEqual(expected);
  });

  it('edits to an existing first page on a pre-made branch are refused, since that page is not written', async () => {
    const r = repoWith(3001, { 'docs/index.md': '# Ours\n' });
    r.refs.set(work, 'theirs');
    r.files.set(
      work,
      new Map([...r.files.get('main')!, ['docs/index.md', { sha: 'z', content: b64('# Changed by someone\n') }]]),
    );
    repos.set('acme/newdocs', r);
    const res = await add(NEW);
    expect(res.status).toBe(409);
    expect(html(res)).toContain('with other changes (docs/index.md)');
  });

  it('a compare answer without a file list is not taken as no changes', async () => {
    const r = repos.get('acme/docs-hub')!;
    r.refs.set(work, r.refs.get('main')!);
    r.files.set(work, new Map(r.files.get('main')!));
    github.repoApi = async (req, repo, path) =>
      path.startsWith('/compare/') ? Response.json({}) : standIn(req, repo, path);
    const res = await add(NEW);
    expect(res.status).toBe(502);
    expect(html(res)).toContain('GitHub sent no file list');
  });

  it('a 422 creating the branch for another reason reports the refusal, not a compare error', async () => {
    github.repoApi = async (req, repo, path) =>
      req.method === 'POST' && path === '/git/refs'
        ? Response.json({ message: 'bad sha' }, { status: 422 })
        : standIn(req, repo, path);
    const res = await add(NEW);
    expect(res.status).toBe(502);
    expect(html(res)).toContain('GitHub refused it (422)');
  });

  it('repo names YAML would read as another type are quoted', () => {
    const wf = workflowFor({ ...NEW, repo: 'null', ticketRepo: 'null' }, 'main', HOST, COMMIT);
    expect(wf.match(/repo: "null"/g)).toHaveLength(2);
  });

  it('a branch someone else made with other changes is refused, not reused', async () => {
    const r = repos.get('acme/docs-hub')!;
    r.refs.set(work, 'theirs');
    r.files.set(work, new Map([...r.files.get('main')!, ['evil.sh', { sha: 'x', content: b64('rm -rf /') }]]));
    const res = await add(NEW);
    expect(res.status).toBe(409);
    expect(html(res)).toContain('already has a branch specreview/add-newdocs with other changes (evil.sh)');
    expect(r.pulls).toEqual([]);
  });

  it('a site already in the config file is told to wait for the apply run', async () => {
    const r = repos.get('acme/docs-hub')!;
    const withSite = { ...orgFile, sites: [...(orgFile.sites as unknown[]), { repo: 'newdocs' }] };
    r.files.get('main')!.set('specreview.config.json', { sha: 'y', content: b64(JSON.stringify(withSite)) });
    const res = await add(NEW);
    expect(res.status).toBe(409);
    expect(html(res)).toContain('newdocs is already in specreview.config.json on main; wait for the apply workflow');
    expect(calls.some((c) => c.startsWith('POST'))).toBe(false);
  });

  it('a different docs.yml in the product repo is not overwritten', async () => {
    repos.set('acme/newdocs', repoWith(3001, { '.github/workflows/docs.yml': 'name: theirs\n' }));
    const res = await add(NEW);
    expect(res.status).toBe(409);
    expect(html(res)).toContain('acme/newdocs already has .github/workflows/docs.yml on main');
    expect(calls.some((c) => c.startsWith('POST') || c.startsWith('PUT'))).toBe(false);
  });

  it('an open pull request from the branch to another base is refused, not reported as done', async () => {
    expect((await add(NEW)).status).toBe(200);
    repos.get('acme/newdocs')!.pulls[0].base = 'release';
    const res = await add(NEW);
    expect(res.status).toBe(409);
    expect(html(res)).toContain('already merges specreview/add-newdocs into release');
  });

  it('GitHub not answering part way names the step and lists what was made', async () => {
    let n = 0;
    github.repoApi = async (req, repo, path) => {
      if (repo === 'acme/newdocs' && req.method === 'POST' && path === '/git/refs' && ++n === 1)
        throw new TypeError('network down');
      return standIn(req, repo, path);
    };
    const res = await add(NEW);
    expect(res.status).toBe(502);
    expect(html(res)).toContain('creating specreview/add-newdocs on acme/newdocs: GitHub did not answer (TypeError)');
    expect(html(res)).toContain('https://github.com/acme/docs-hub/pull/1');
  });

  it('a default branch name the workflow cannot hold is refused', async () => {
    const r = repoWith(3001, {});
    r.default = 'we*ird';
    repos.set('acme/newdocs', r);
    const res = await add(NEW);
    expect(res.status).toBe(409);
    expect(html(res)).toContain('the branch name we*ird is not supported');
  });

  it('a form over 4 KB is refused', async () => {
    const res = await add({ ...NEW, docs: 'a'.repeat(5000) });
    expect(res.status).toBe(413);
    expect(calls).toEqual([]);
  });

  it('when GitHub cannot be asked about the install, the message says the token failed, not the permissions', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    github.app!.failLookups = [500, 500, 500, 500];
    const res = await add(NEW);
    expect(res.status).toBe(409);
    expect(html(res)).toContain('the app could not get a token for acme/newdocs');
  });
});

describe('#63: the form offers lists from GitHub', () => {
  const page = async (query = '') =>
    html(await call(`/_admin/${query}`, { raw: true, email: ADMIN, envOverride: env }));
  const options = (htmlText: string, name: string) => {
    const block = new RegExp(`<select name="${name}">(.*?)</select>`, 's').exec(htmlText)?.[1] ?? '';
    return [...block.matchAll(/<option value="([^"]*)"( selected)?>/g)].map((m) => (m[2] ? `*${m[1]}` : m[1]));
  };

  it('3: step 1 lists the repos the app reaches, less sites, the config repo and archived ones; Next is a GET', async () => {
    github.app!.installations.set('acme/oldthing', 7);
    github.app!.archived.add('oldthing');
    const p = await page();
    expect(p).toContain('<form method="get" action="/_admin/">');
    expect(options(p, 'repo')).toEqual(['newdocs']);
  });

  it('4: step 2 has the branches with the default chosen, the repo as ticket repo, and team domains', async () => {
    const r = repos.get('acme/newdocs')!;
    r.refs.set('develop', 'devsha');
    const p = await page('?repo=newdocs');
    expect(p).toContain('<input type="hidden" name="repo" value="newdocs">');
    expect(options(p, 'branch')).toEqual(['develop', '*main']);
    expect(options(p, 'ticketRepo')).toContain('*newdocs');
    expect(options(p, 'ticketRepo')).toContain('sidecar');
    // A text box with suggestions, so a new team's domain can be typed.
    expect(p).toContain('<input name="teamDomain" value="acme.dev" list="teamDomain-options"');
    const suggested = [
      ...(/<datalist id="teamDomain-options">(.*?)<\/datalist>/s.exec(p)?.[1] ?? '').matchAll(/value="([^"]+)"/g),
    ].map((m) => m[1]);
    expect(suggested[0]).toBe('acme.dev');
    expect(suggested).toContain('globex.dev');
    expect(new Set(suggested).size).toBe(suggested.length);
    // Any reachable repo can hold the tickets: sites and the config repo too.
    expect(options(p, 'ticketRepo')).toContain('docs-hub');
    expect(p).toContain('<form method="post" action="/_admin/sites">');
  });

  it('5: a malformed repo, or one GitHub does not show, is step 1 again with a note', async () => {
    const bad = await page('?repo=Bad%20Name!');
    expect(bad).toContain('That is not a repo name.');
    expect(bad).toContain('<select name="repo">');
    expect(calls.filter((c) => c.includes('/branches'))).toEqual([]);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const ghost = await page('?repo=ghost');
    expect(ghost).toContain('GitHub does not show ghost to the app');
    expect(await page('?repo=sidecar')).toContain('sidecar is already a site.');
    expect(await page('?repo=docs-hub')).toContain('The repo holding the config cannot be a docs site.');
  });

  it("5: a repo installed after step 1 was listed still gets step 2, whatever step 1's cache holds", async () => {
    await page();
    github.app!.installations.set('acme/brandnew', 7);
    repos.set('acme/brandnew', repoWith(5001, {}));
    const p = await page('?repo=brandnew');
    expect(options(p, 'branch')).toEqual(['*main']);
  });

  it('6: lists longer than a page are read to the end; past twenty pages the field is text with a note', async () => {
    for (let i = 0; i < 150; i++) github.app!.installations.set(`acme/repo${String(i).padStart(3, '0')}`, 7);
    const r = repos.get('acme/newdocs')!;
    for (let i = 0; i < 130; i++) r.refs.set(`b${String(i).padStart(3, '0')}`, `s${i}`);
    expect(options(await page(), 'repo')).toHaveLength(151);
    expect(options(await page('?repo=newdocs'), 'branch')).toHaveLength(131);
    for (let i = 150; i < 2001; i++) github.app!.installations.set(`acme/repo${String(i).padStart(4, '0')}`, 7);
    const { forgetGitHubAppForTests } = await import('../src/github-auth');
    forgetGitHubAppForTests();
    const many = await page();
    expect(many).toContain('There are too many repos to list; type the names.');
    expect(many).toContain('<input name="repo"');
  });

  it('7: the repo list uses a whole-installation token with Metadata read only; branches a one-repo Contents read token', async () => {
    await page('?repo=newdocs');
    const bodies = github.app!.mints.map((m) => m.body);
    expect(bodies).toContainEqual({ permissions: { metadata: 'read' } });
    expect(bodies).toContainEqual({ repositories: ['newdocs'], permissions: { contents: 'read' } });
  });

  it('8: when GitHub cannot list, the form is typed, with a note', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    github.app!.failLookups = [500, 500, 500];
    const p = await page();
    expect(p).toContain('GitHub did not list the repos in time, or could not; type the names.');
    expect(p).toContain('<input name="repo"');
  });

  it('9: names are escaped in options and inputs', async () => {
    repos.get('acme/newdocs')!.refs.set('x&y', 'amp');
    repos.get('acme/newdocs')!.refs.set('q"<b', 'odd');
    const p = await page('?repo=newdocs');
    expect(p).toContain('<option value="x&amp;y">x&amp;y</option>');
    expect(p).toContain('<option value="q&quot;&lt;b">q&quot;&lt;b</option>');
    expect(p).not.toContain('value="x&y"');
  });
});

describe('#63 review fixes: listing', () => {
  it('a failing listing is remembered for a while, not repeated on every page load', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Only the org's installation lookup fails, and only the first time.
    let lookups = 0;
    const real = spy.getMockImplementation()!;
    spy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(new Request(input, init).url);
      if (url.pathname === '/orgs/acme/installation' && ++lookups === 1) return new Response('down', { status: 503 });
      return real(input, init);
    });
    const page = () => call('/_admin/', { raw: true, email: ADMIN, envOverride: env });
    const [first] = await Promise.all([page(), page()]);
    expect(html(first)).toContain('GitHub did not list the repos in time, or could not');
    // Within 30 seconds the failure is remembered: no new lookup, still the typed form.
    expect(html(await page())).toContain('GitHub did not list the repos in time, or could not');
    expect(lookups).toBe(1);
  });
});
