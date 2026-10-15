import { isRepoName, problemsIn, type HubConfig } from './config';
import type { Env } from './env';
import { LIST_PAGES } from './github-app';
import type { GitHubAuth, Purpose } from './github-auth';
import { API, githubFetch, redirectOf } from './github-fetch';

// Adding a site from the admin page (#57): the organisation's GitHub App opens
// two pull requests, one on the repo holding the hub's config that adds the
// site, and one on the product repo that adds the docs workflow (and a first
// page when there is none). Merging the config one deploys the hub with the
// site; the product one then publishes.

export const WORKFLOW = '.github/workflows/docs.yml';
export const CONFIG_FILE = 'specreview.config.json';

export type SiteInput = { repo: string; branch: string; docs: string; ticketRepo: string; teamDomain: string };
export type Made = { what: string; url?: string };
export type Added = { config: string; product: string; made: Made[] };

// Why adding stopped: the status the page answers and a sentence for it.
export class AddSiteError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly made: Made[] = [],
  ) {
    super(message);
  }
}

const BRANCH = /^(?!\/)(?!.*\/\/)(?!.*\.\.)(?!.*\/$)[A-Za-z0-9._/-]{1,100}$/;
const FOLDER = /^(?!.*(^|\/)\.\.?(\/|$))[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const refPath = (branch: string) => branch.split('/').map(encodeURIComponent).join('/');

// Shape only: what GitHub and the config say is checked later.
export const inputProblem = (input: SiteInput, config: HubConfig): string | null => {
  if (!isRepoName(input.repo) || input.repo.startsWith('_')) return 'repo: a lowercase repo name';
  if (input.branch && !BRANCH.test(input.branch)) return 'branch: a branch name';
  // `.` is the whole repo (#87).
  if ((input.docs !== '.' && !FOLDER.test(input.docs)) || input.docs.length > 100)
    return 'docs folder: a folder path in the repo, or . for the whole repo';
  if (!isRepoName(input.ticketRepo)) return 'ticket repo: a lowercase repo name';
  if (!/^[a-z0-9.-]{1,253}$/.test(input.teamDomain)) return 'team domain: a lowercase domain';
  if (config.configRepo === `${config.org}/${input.repo}`)
    return 'repo: the repo holding the config cannot be a docs site';
  return null;
};

// In chunks: spreading a large file into one call overflows the stack.
export const b64 = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};
export const unb64 = (text: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(text.replace(/\s+/g, '')), (c) => c.charCodeAt(0)));

export const workflowFor = (input: SiteInput, branch: string, origin: string, commit: string) =>
  `# Builds this repo's docs folder and publishes it to the specreview hub.
# Added from the hub's admin page; the actions are pinned to the commit the
# hub runs.
name: docs

on:
  push:
    branches: [${JSON.stringify(branch)}]
  pull_request:

permissions:
  contents: read

# One publish at a time, in order; a newer run never races an older one.
concurrency:
  group: docs-\${{ github.ref }}
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0 # page history needs every commit
          persist-credentials: false
      - uses: jadedm/specreview/build@${commit}
        with:
          repo: ${JSON.stringify(input.repo)}
          docs: ${JSON.stringify(input.docs)}
      # Only a push publishes, so only a push keeps the build, for a day.
      - if: github.event_name == 'push'
        uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
        with:
          name: docs-site
          path: .specreview
          include-hidden-files: true
          retention-days: 1

  # Pushes to the branch only; pull requests stop after the build.
  publish:
    if: github.event_name == 'push'
    needs: build
    runs-on: ubuntu-latest
    permissions:
      id-token: write
    steps:
      - uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2
        with:
          name: docs-site
          path: .specreview
      - uses: jadedm/specreview/publish@${commit}
        with:
          hub: ${origin}
          repo: ${JSON.stringify(input.repo)}
`;

const STARTER = (repo: string) =>
  `# ${repo}\n\nThe first page of ${repo}'s docs. Add pages as Markdown files in this folder; folders become sections.\n`;

export type Call = (repo: string, purpose: Purpose, method: string, path: string, body?: unknown) => Promise<Response>;

export const caller =
  (auth: GitHubAuth): Call =>
  async (repo, purpose, method, path, body) => {
    const token = await auth.tokenFor(repo, purpose);
    if (!token) throw new AddSiteError(409, `the app has no token for ${repo}`);
    return githubFetch(`${API}/repos/${repo}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'specreview',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
  };

// Each GitHub step either answers as expected or stops the run, naming the
// step and what was already made. A call that gets no answer at all (network,
// timeout) is reported the same way.
const steps = (call: Call, made: Made[]) => {
  let step = 'starting';
  const ask = (now: string, ...args: Parameters<Call>) => {
    step = now;
    return call(...args).catch((err: unknown) => {
      if (err instanceof AddSiteError) throw new AddSiteError(err.status, `${now}: ${err.message}`, made);
      throw new AddSiteError(
        502,
        `${now}: GitHub did not answer (${err instanceof Error ? err.name : typeof err})`,
        made,
      );
    });
  };
  const json = async <T>(res: Response, ok: number[]): Promise<T> => {
    if (ok.includes(res.status)) return (await res.json().catch(() => ({}))) as T;
    const redirect = redirectOf(res);
    throw new AddSiteError(
      502,
      `${step}: GitHub answered ${redirect ? `with a redirect (${redirect})` : res.status}`,
      made,
    );
  };
  const stop = (status: number, message: string) => new AddSiteError(status, message, made);
  const repoOf = async (repo: string, purpose: Purpose) => {
    const res = await ask(`reading ${repo}`, repo, purpose, 'GET', '');
    if (res.status === 404) throw stop(400, `${repo} was not found`);
    return json<{ id: number; default_branch: string }>(res, [200]);
  };
  const headOf = async (repo: string, purpose: Purpose, branch: string) => {
    const res = await ask(`reading ${repo} ${branch}`, repo, purpose, 'GET', `/git/ref/heads/${refPath(branch)}`);
    if (res.status === 404) throw stop(400, `${repo} has no branch ${branch}`);
    return (await json<{ object: { sha: string } }>(res, [200])).object.sha;
  };
  // A branch from an earlier run is reused only if it changes nothing but the
  // files this writes: someone else's commits must not ride in under the
  // hub's name.
  const branchAt = async (repo: string, purpose: Purpose, name: string, base: string, sha: string, ours: string[]) => {
    const res = await ask(`creating ${name} on ${repo}`, repo, purpose, 'POST', '/git/refs', {
      ref: `refs/heads/${name}`,
      sha,
    });
    if (res.status === 201) {
      made.push({ what: `branch ${name} on ${repo}` });
      return;
    }
    if (res.status !== 422) await json(res, [201]);
    // 422 is GitHub's answer for an existing branch; any other cause shows here.
    const there = await ask(`reading ${name} on ${repo}`, repo, purpose, 'GET', `/git/ref/heads/${refPath(name)}`);
    if (there.status !== 200) throw stop(502, `creating ${name} on ${repo}: GitHub refused it (422)`);
    const diff = await json<{ files?: { filename: string }[] }>(
      await ask(`comparing ${name} on ${repo}`, repo, purpose, 'GET', `/compare/${refPath(base)}...${refPath(name)}`),
      [200],
    );
    // An answer without the file list is not "no changes".
    if (!Array.isArray(diff.files)) throw stop(502, `comparing ${name} on ${repo}: GitHub sent no file list`);
    const other = diff.files.map((f) => f.filename).filter((f) => !ours.includes(f));
    if (other.length > 0)
      throw stop(
        409,
        `${repo} already has a branch ${name} with other changes (${other.slice(0, 3).join(', ')}); delete it and add the site again`,
      );
  };
  const fileAt = async (repo: string, purpose: Purpose, path: string, ref: string) => {
    const res = await ask(
      `reading ${path} on ${repo}`,
      repo,
      purpose,
      'GET',
      `/contents/${path}?ref=${encodeURIComponent(ref)}`,
    );
    if (res.status === 404) return null;
    return json<{ sha: string; content: string }>(res, [200]);
  };
  const write = async (repo: string, purpose: Purpose, path: string, branch: string, text: string, message: string) => {
    const existing = await fileAt(repo, purpose, path, branch);
    if (existing && unb64(existing.content) === text) return;
    const res = await ask(`writing ${path} on ${repo}`, repo, purpose, 'PUT', `/contents/${path}`, {
      message,
      content: b64(text),
      branch,
      ...(existing ? { sha: existing.sha } : {}),
    });
    await json(res, [200, 201]);
    made.push({ what: `${path} on ${repo} (${branch})` });
  };
  // An open pull request from an earlier run is reused when it targets the
  // same branch; one from this branch to another is not this site's.
  const pull = async (repo: string, purpose: Purpose, head: string, base: string, title: string, body: string) => {
    const owner = repo.split('/')[0];
    const open = await json<{ html_url: string; base: { ref: string } }[]>(
      await ask(
        `listing pull requests on ${repo}`,
        repo,
        purpose,
        'GET',
        `/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}`,
      ),
      [200],
    );
    if (open[0]?.base.ref === base) return open[0].html_url;
    if (open[0])
      throw stop(
        409,
        `${open[0].html_url} already merges ${head} into ${open[0].base.ref}; close it and add the site again`,
      );
    const created = await json<{ html_url: string }>(
      await ask(`opening the pull request on ${repo}`, repo, purpose, 'POST', '/pulls', { title, head, base, body }),
      [201],
    );
    made.push({ what: `pull request on ${repo}`, url: created.html_url });
    return created.html_url;
  };
  return { repoOf, headOf, branchAt, fileAt, write, pull, stop };
};

// The config with the site added, checked by the hub's own rules (the Access
// fields come from deploy and the brand is resolved there, so they are
// supplied or left out here). A site already in the file stops the run: its
// pull request was merged and the hub has not been deployed with it yet, or
// it differs from what was asked now.
const configWith = (text: string, site: Record<string, unknown>, hub: HubConfig) => {
  const parsed = (() => {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return null;
    }
  })();
  if (!parsed) return { problems: ['the file is not valid JSON'] };
  const sites = Array.isArray(parsed.sites) ? parsed.sites : [];
  if (sites.some((s) => (s as { repo?: unknown }).repo === site.repo)) return { present: true as const, problems: [] };
  const next: Record<string, unknown> = { ...parsed, sites: [...sites, site] };
  const { brand: _brand, ...checked } = next;
  const problems = problemsIn({ ...checked, accessTeamDomain: hub.accessTeamDomain, accessAud: hub.accessAud });
  return { text: `${JSON.stringify(next, null, 2)}\n`, problems };
};

export const addSite = async (
  input: SiteInput,
  ctx: { config: HubConfig; env: Env; auth: GitHubAuth; origin: string; email: string },
): Promise<Added> => {
  const { config, env, auth, origin } = ctx;
  const configRepo = config.configRepo;
  const commit = env.SPECREVIEW_COMMIT;
  if (!configRepo || !commit)
    throw new AddSiteError(409, 'the hub does not know its config repo or its specreview commit');
  if (config.sites.has(input.repo)) throw new AddSiteError(409, `${input.repo} is already a site`);
  const product = `${config.org}/${input.repo}`;
  const tickets = `${config.org}/${input.ticketRepo}`;
  // Only the app can add a site; personal tokens cannot.
  if (!(await auth.hasApp?.())) throw new AddSiteError(409, 'the hub has no GitHub App');
  // Installed, and holding the setup permissions, before anything is written.
  for (const [repo, purpose] of [
    [product, 'setup-product'],
    [configRepo, 'setup-config'],
  ] as const) {
    const installed = await auth.installed?.(repo);
    if (installed === false) throw new AddSiteError(409, `the app is not installed on ${repo}`);
    if (await auth.tokenFor(repo, purpose)) continue;
    if (installed === null)
      throw new AddSiteError(409, `the app could not get a token for ${repo}; check its key and GitHub`);
    throw new AddSiteError(409, `the app cannot write to ${repo}: it lacks Contents, Pull requests or Workflows write`);
  }
  if ((await auth.installed?.(tickets)) === false)
    throw new AddSiteError(409, `the app is not installed on ${tickets}`);

  const made: Made[] = [];
  const gh = steps(caller(auth), made);
  const info = await gh.repoOf(product, 'setup-product');
  const branch = input.branch || info.default_branch;
  if (!BRANCH.test(branch)) throw gh.stop(409, `the branch name ${branch} is not supported; choose another branch`);
  const productHead = await gh.headOf(product, 'setup-product', branch);
  const workflow = workflowFor(input, branch, origin, commit);
  const existingWorkflow = await gh.fileAt(product, 'setup-product', WORKFLOW, branch);
  if (existingWorkflow && unb64(existingWorkflow.content) !== workflow)
    throw gh.stop(409, `${product} already has ${WORKFLOW} on ${branch}; rename or remove it and add the site again`);
  const work = `specreview/add-${input.repo}`;
  const site = {
    repo: input.repo,
    teamDomains: [input.teamDomain],
    approvers: [],
    readers: [],
    ticketRepo: input.ticketRepo,
    branch,
    repositoryId: String(info.id),
    workflow: WORKFLOW,
  };

  // The config change is checked before any branch exists anywhere.
  const cfgInfo = await gh.repoOf(configRepo, 'setup-config');
  const cfgBase = cfgInfo.default_branch;
  const current = await gh.fileAt(configRepo, 'setup-config', CONFIG_FILE, cfgBase);
  if (!current) throw gh.stop(409, `${configRepo} has no ${CONFIG_FILE} on ${cfgBase}`);
  const next = configWith(unb64(current.content), site, config);
  if (next.present)
    throw gh.stop(
      409,
      `${input.repo} is already in ${CONFIG_FILE} on ${cfgBase}; wait for the apply workflow to deploy it`,
    );
  if (next.problems.length > 0 || !next.text)
    throw gh.stop(400, `the config would not be valid: ${next.problems.join('; ')}`);

  await gh.branchAt(configRepo, 'setup-config', work, cfgBase, await gh.headOf(configRepo, 'setup-config', cfgBase), [
    CONFIG_FILE,
  ]);
  await gh.write(configRepo, 'setup-config', CONFIG_FILE, work, next.text, `feat: add ${input.repo} as a docs site`);
  const configPull = await gh.pull(
    configRepo,
    'setup-config',
    work,
    cfgBase,
    `Add ${input.repo} as a docs site`,
    `Adds ${input.repo} to the hub's sites, requested on the admin page by ${ctx.email}.\n\nMerge this first and wait for the apply workflow to finish green. Then merge the docs pull request on ${product}; its push publishes the site.`,
  );

  const inDocs = (name: string) => (input.docs === '.' ? name : `${input.docs}/${name}`);
  const index = inDocs('index.md');
  // The first page is one of ours only when it will be written: not when the
  // folder has a home page already, index.md or a README.md (#87).
  const hasHome =
    (await gh.fileAt(product, 'setup-product', index, branch)) ||
    (await gh.fileAt(product, 'setup-product', inDocs('README.md'), branch));
  const needsIndex = !hasHome;
  await gh.branchAt(product, 'setup-product', work, branch, productHead, needsIndex ? [WORKFLOW, index] : [WORKFLOW]);
  await gh.write(product, 'setup-product', WORKFLOW, work, workflow, 'ci: publish docs to specreview');
  if (needsIndex)
    await gh.write(product, 'setup-product', index, work, STARTER(input.repo), 'docs: add the first docs page');
  const productPull = await gh.pull(
    product,
    'setup-product',
    work,
    branch,
    'Publish docs to specreview',
    `Adds the workflow that builds ${input.docs === '.' ? 'the whole repo' : `\`${input.docs}/\``} and publishes it to ${origin}/${input.repo}/, requested on the admin page by ${ctx.email}.\n\nMerge ${configPull} first and wait for its apply workflow to finish green, then merge this. If the docs run on the merge is refused because the hub does not know the site yet, re-run it once the hub is deployed.`,
  );
  return { config: configPull, product: productPull, made };
};

// A repo's branches for the add-site form (#63): its default and every
// branch (paged to the end; past LIST_PAGES the form asks for text), with a
// token for that repo holding only Contents read. 'missing' when GitHub does
// not show the repo to the app; null when GitHub cannot be asked.
export type Branches = { defaultBranch: string; names: string[] | 'too-many' };

export const listBranches = async (auth: GitHubAuth, repo: string): Promise<Branches | 'missing' | null> => {
  const get = async (path: string) => {
    const token = await auth.tokenFor(repo, 'browse');
    // No token because the app is not installed there: GitHub does not show it.
    if (!token) return (await auth.installed?.(repo)) === false ? new Response(null, { status: 404 }) : null;
    return githubFetch(`${API}/repos/${repo}${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'specreview',
      },
      signal: AbortSignal.timeout(5_000),
    }).catch(() => null);
  };
  const info = await get('');
  if (info?.status === 404) return 'missing';
  if (!info?.ok) return null;
  const { default_branch: defaultBranch } = (await info.json()) as { default_branch: string };
  const names: string[] = [];
  for (let page = 1; page <= LIST_PAGES; page++) {
    const res = await get(`/branches?per_page=100&page=${page}`);
    if (!res?.ok) return null;
    const batch = (await res.json()) as { name: string }[];
    names.push(...batch.map((b) => b.name));
    if (batch.length < 100) return { defaultBranch, names };
  }
  return { defaultBranch, names: 'too-many' };
};
