import { isExcludePattern } from '@specreview/shared';
import { isRepoName, problemsIn, type HubConfig, type Site } from './config';
import type { Env } from './env';
import { LIST_PAGES } from './github-app';
import type { GitHubAuth, Purpose } from './github-auth';
import { API, githubFetch, redirectOf } from './github-fetch';
import { PUBLISH_WORKFLOW_PATH, PUBLISH_WORKFLOW_REPO } from './github-oidc';

// Adding a site from the admin page (#57): the organisation's GitHub App opens
// two pull requests, one on the repo holding the hub's config that adds the
// site, and one on the product repo that adds the docs workflow (and a first
// page when there is none). Merging the config one deploys the hub with the
// site; the product one then publishes.

export const WORKFLOW = '.github/workflows/docs.yml';
export const CONFIG_FILE = 'specreview.config.json';

export type SiteInput = {
  repo: string;
  branch: string;
  docs: string;
  ticketRepo: string;
  teamDomain: string;
  // Paths left out of the site (#88), relative to the docs folder.
  exclude?: string[];
};

// From the admin page's form: fewer and shorter than the CLI takes, so the
// form stays within its 4 KB limit.
export const FORM_EXCLUDES = 10;
export const FORM_EXCLUDE_LENGTH = 100;
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
  const exclude = input.exclude ?? [];
  if (exclude.length > FORM_EXCLUDES || exclude.some((p) => !isExcludePattern(p, FORM_EXCLUDE_LENGTH)))
    return `leave out: at most ${FORM_EXCLUDES} paths in the docs folder, comma separated, with * and ** as wildcards`;
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

// Patterns are checked (isExcludePattern) before they get here: no quote,
// colon or line break can reach the YAML.
const block = (key: string, patterns: string[] = []) =>
  patterns.length === 0 ? '' : `\n      ${key}: |\n${patterns.map((p) => `        ${p}`).join('\n')}`;

// What a product repo's caller passes to the reusable workflow. `runner` is
// the runs-on labels both of its jobs use (#185); none means ubuntu-latest.
export type CallerInputs = { repo: string; docs: string; exclude?: string[]; prototypes?: string[]; runner?: string[] };

// Runner labels as the caller may hold them: these characters only, so their
// JSON holds no quote that the single-quoted YAML around it would need
// doubled, and nothing else YAML or GitHub's expressions read.
const LABEL = /^[A-Za-z0-9._-]{1,100}$/;
export const MAX_LABELS = 10;
export const isRunner = (labels: string[]) =>
  labels.length >= 1 && labels.length <= MAX_LABELS && labels.every((l) => LABEL.test(l));
// GitHub matches runner labels case aside, and a runner must carry every
// label listed, so order and repeats do not matter.
const sameLabel = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const labelSet = (labels: string[]) => [...new Set(labels.map((l) => l.toLowerCase()))].sort().join(' ');
const sameRunner = (a: string[], b: string[]) => labelSet(a) === labelSet(b);
const DEFAULT_RUNNER = 'ubuntu-latest';

// The caller's `runner` line, or nothing for the reusable workflow's default.
const runnerLine = (labels: string[] = [DEFAULT_RUNNER]) => {
  if (labels.length === 1 && sameLabel(labels[0], DEFAULT_RUNNER)) return '';
  if (!isRunner(labels)) throw new Error('runner labels outside the rules reached the workflow');
  return `\n      runner: '${JSON.stringify(labels.length === 1 ? labels[0] : labels)}'`;
};

// A product repo's docs workflow (#177): one job calling specreview's
// reusable workflow pinned to the commit the hub runs. The hub accepts
// publishes only from that workflow.
export const workflowFor = (input: CallerInputs, branch: string, origin: string, commit: string) =>
  `# Builds this repo's docs folder and publishes it to the specreview hub,
# through specreview's reusable workflow pinned to the commit the hub runs.
# Added from the hub's admin page. When the hub upgrades to a new specreview
# release, the admin page's Sites tab opens a pull request moving the pin.
name: docs

on:
  push:
    branches: [${JSON.stringify(branch)}]
  # Pull requests build the docs and stop; only a push publishes.
  pull_request:

# One publish at a time, in order; a newer run never races an older one.
concurrency:
  group: docs-\${{ github.ref }}
  cancel-in-progress: false

jobs:
  docs:
    # The called workflow's build job reads the repo; its publish job asks
    # GitHub for the token the hub checks.
    permissions:
      contents: read
      id-token: write
    uses: ${PUBLISH_WORKFLOW_REPO}/${PUBLISH_WORKFLOW_PATH}@${commit}
    with:
      hub: ${origin}
      repo: ${JSON.stringify(input.repo)}
      docs: ${JSON.stringify(input.docs)}${runnerLine(input.runner)}${block('exclude', input.exclude)}${block('prototypes', input.prototypes)}
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
        `${repo} already has a branch ${name} with other changes (${other.slice(0, 3).join(', ')}); delete it and try again`,
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
      throw stop(409, `${open[0].html_url} already merges ${head} into ${open[0].base.ref}; close it and try again`);
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

// Installed, and holding the setup permissions, before anything is written.
const canWrite = async (auth: GitHubAuth, repo: string, purpose: Purpose) => {
  const installed = await auth.installed?.(repo);
  if (installed === false) throw new AddSiteError(409, `the app is not installed on ${repo}`);
  if (await auth.tokenFor(repo, purpose)) return;
  if (installed === null)
    throw new AddSiteError(409, `the app could not get a token for ${repo}; check its key and GitHub`);
  throw new AddSiteError(409, `the app cannot write to ${repo}: it lacks Contents, Pull requests or Workflows write`);
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
  await canWrite(auth, product, 'setup-product');
  await canWrite(auth, configRepo, 'setup-config');
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

// A site's docs workflow pins specreview to a commit (#148): since #177 one
// `uses:` of the reusable workflow, before it the build and publish actions
// in two jobs of its own. When the hub moves to a new release, the Sites tab
// shows which sites pin another commit and opens a pull request moving them;
// a site still on the two jobs gets a pull request replacing its workflow
// with the caller, since the hub takes publishes only from the reusable one.
// Only a `uses:` key at the start of its line counts (after the indent and a
// list dash): not a comment, a `run:` line or another owner's action or
// workflow whose name ends the same way.
const USES =
  /(?<=^[ \t]*(?:-[ \t]+)?uses:[ \t]*["']?)(jadedm\/specreview\/(build|publish|\.github\/workflows\/publish-docs\.yml)@)([^\s"'#]*)/gm;
const COMMIT = /^[0-9a-f]{40}$/;
export type Pins = { style: 'reusable' | 'actions'; commits: string[] };
// The commits the file pins, with its style: the reusable workflow alone, or
// both actions; null for anything else, or any use that is not a commit.
export const pinsOf = (text: string): Pins | null => {
  const uses = [...text.matchAll(USES)];
  if (uses.length === 0 || uses.some((m) => !COMMIT.test(m[3]))) return null;
  const names = new Set(uses.map((m) => m[2]));
  const commits = [...new Set(uses.map((m) => m[3]))];
  if (names.size === 1 && names.has(PUBLISH_WORKFLOW_PATH)) return { style: 'reusable', commits };
  if (names.size === 2 && names.has('build') && names.has('publish')) return { style: 'actions', commits };
  return null;
};
const withPins = (text: string, commit: string) => text.replace(USES, `$1${commit}`);
const unpinned = (text: string) => text.replace(USES, '$1');
// The file as GitHub holds it: a byte-order mark kept, so writing it back
// changes nothing but the pins; null when it is not UTF-8.
const exactText = (content: string) => {
  try {
    return new TextDecoder('utf-8', { ignoreBOM: true, fatal: true }).decode(
      Uint8Array.from(atob(content.replace(/\s+/g, '')), (c) => c.charCodeAt(0)),
    );
  } catch {
    return null;
  }
};
export const shortCommit = (commit: string) => commit.slice(0, 7);

export type Pinned =
  | { kind: 'current' }
  | { kind: 'other'; commits: string[] }
  | { kind: 'actions'; commits: string[] }
  | { kind: 'missing' }
  | { kind: 'unpinned' }
  | { kind: 'unreadable' };

// The site's workflow on its branch, with a token holding only Contents read.
export const pinnedOf = async (auth: GitHubAuth, repo: string, site: Site, commit: string): Promise<Pinned> => {
  const token = await auth.tokenFor(repo, 'browse');
  if (!token) return { kind: 'unreadable' };
  const res = await githubFetch(
    `${API}/repos/${repo}/contents/${site.workflow}?ref=${encodeURIComponent(site.branch)}`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'specreview',
      },
      signal: AbortSignal.timeout(5_000),
    },
  ).catch(() => null);
  if (res?.status === 404) return { kind: 'missing' };
  const file = res?.ok ? ((await res.json().catch(() => null)) as { content?: unknown } | null) : null;
  if (typeof file?.content !== 'string') return { kind: 'unreadable' };
  const pins = pinsOf(exactText(file.content) ?? '');
  if (!pins) return { kind: 'unpinned' };
  if (pins.style === 'actions') return { kind: 'actions', commits: pins.commits };
  return pins.commits.every((c) => c === commit) ? { kind: 'current' } : { kind: 'other', commits: pins.commits };
};

type Ctx = { config: HubConfig; env: Env; auth: GitHubAuth; email: string };

// What both moves check before reading the file: the hub's commit, the app,
// and that it may write the workflow.
const ready = async (site: Site, ctx: Ctx) => {
  const commit = ctx.env.SPECREVIEW_COMMIT;
  if (!commit) throw new AddSiteError(409, 'the hub does not know its specreview commit');
  if (!(await ctx.auth.hasApp?.())) throw new AddSiteError(409, 'the hub has no GitHub App');
  const product = `${ctx.config.org}/${site.repo}`;
  const purpose: Purpose = 'setup-product';
  await canWrite(ctx.auth, product, purpose);
  const made: Made[] = [];
  const gh = steps(caller(ctx.auth), made);
  const head = await gh.headOf(product, purpose, site.branch);
  const file = await gh.fileAt(product, purpose, site.workflow, site.branch);
  if (!file) throw gh.stop(409, `${product} has no ${site.workflow} on ${site.branch}`);
  const current = exactText(file.content);
  if (current === null) throw gh.stop(409, `${site.workflow} on ${site.branch} is not UTF-8 text`);
  return { commit, product, purpose, made, gh, head, current };
};

// Opens a pull request on the site's repo moving the reusable workflow's pin
// to the hub's commit, changing nothing else in the file, so a team's own
// edits to it stay.
export const upgradeSite = async (site: Site, ctx: Ctx): Promise<{ pull: string; made: Made[] }> => {
  const { commit, product, purpose, made, gh, head, current } = await ready(site, ctx);
  const pins = pinsOf(current);
  if (pins?.style === 'actions')
    throw gh.stop(
      409,
      `${site.workflow} on ${site.branch} uses the two specreview actions; move it to the reusable workflow`,
    );
  if (!pins)
    throw gh.stop(409, `${site.workflow} on ${site.branch} does not pin specreview's reusable workflow to a commit`);
  if (pins.commits.every((c) => c === commit)) throw gh.stop(409, `${site.repo} is already on the hub's commit`);
  const short = shortCommit(commit);
  // One branch per target commit: a branch left from an earlier upgrade,
  // squash-merged, would conflict with the base it was merged into.
  const work = `specreview/upgrade-${site.repo}-${short}`;
  await gh.branchAt(product, purpose, work, site.branch, head, [site.workflow]);
  // A branch from an earlier run is reused only if its workflow differs from
  // the site's in the pins alone: an edit pushed there would be overwritten.
  const there = await gh.fileAt(product, purpose, site.workflow, work);
  const onBranch = there && exactText(there.content);
  if (!onBranch || unpinned(onBranch) !== unpinned(current))
    throw gh.stop(
      409,
      `${product} already has a branch ${work} with other changes to ${site.workflow}; delete it and try again`,
    );
  await gh.write(product, purpose, site.workflow, work, withPins(current, commit), `ci: move specreview to ${short}`);
  const pull = await gh.pull(
    product,
    purpose,
    work,
    site.branch,
    `Move specreview to ${short}`,
    `Moves specreview's reusable workflow in \`${site.workflow}\` to ${commit}, the commit the docs hub runs, requested on the admin page by ${ctx.email}. Nothing else in the file changes.\n\nMerging publishes the docs with the hub's version.`,
  );
  return { pull, made };
};

// Reading the two-job workflow's inputs (#177), so the caller that replaces
// it keeps them. Only the shapes specreview's template and the admin page
// wrote: one step per action, its `with:` keys plain or quoted scalars, or
// `|` blocks holding one path a line. Anything else is refused, naming it.
type Value = string | string[];
const indentOf = (line: string) => line.length - line.trimStart().length;
const skipped = (line: string) => !line.trim() || line.trim().startsWith('#');

const scalarOf = (rest: string): string | null => {
  const double = /^"((?:[^"\\]|\\.)*)"[ \t]*(?:#.*)?$/.exec(rest);
  if (double) {
    try {
      return JSON.parse(`"${double[1]}"`) as string;
    } catch {
      return null;
    }
  }
  const single = /^'((?:[^']|'')*)'[ \t]*(?:#.*)?$/.exec(rest);
  if (single) return single[1].replace(/''/g, "'");
  const plain = rest.replace(/[ \t]+#.*$/, '').trim();
  // Anchors, aliases, tags, flow collections, folded blocks and the like.
  return /^[^&*!|>%@`{["'#]/.test(plain) ? plain : null;
};

const usesOf = (lines: string[], name: 'build' | 'publish') => {
  const usesLine = new RegExp(`^[ \\t]*(?:-[ \\t]+)?uses:[ \\t]*["']?jadedm\\/specreview\\/${name}@`);
  return lines.flatMap((l, i) => (usesLine.test(l) ? [i] : []));
};

const stepInputs = (lines: string[], name: 'build' | 'publish'): Map<string, Value> | string => {
  const at = usesOf(lines, name);
  if (at.length !== 1) return `it uses jadedm/specreview/${name} in ${at.length} steps`;
  const dash = /^[ \t]*-[ \t]+/.exec(lines[at[0]]);
  const keyIndent = dash ? dash[0].length : indentOf(lines[at[0]]);
  // The step's keys after its uses line, until a line further out.
  let i = at[0] + 1;
  for (; i < lines.length; i++) {
    if (skipped(lines[i])) continue;
    if (indentOf(lines[i]) < keyIndent) break;
    if (indentOf(lines[i]) === keyIndent && /^with:[ \t]*(?:#.*)?$/.test(lines[i].trim())) break;
  }
  if (i >= lines.length || indentOf(lines[i]) < keyIndent) return `the ${name} step has no with: after its uses: line`;
  const values = new Map<string, Value>();
  let valueIndent = -1;
  for (i += 1; i < lines.length; i++) {
    const line = lines[i];
    if (skipped(line)) continue;
    if (indentOf(line) <= keyIndent) break;
    if (valueIndent === -1) valueIndent = indentOf(line);
    const pair = /^([A-Za-z_-]+):[ \t]*(.*)$/.exec(line.trim());
    if (indentOf(line) !== valueIndent || !pair) return `the ${name} step's inputs cannot be read`;
    const [, key, rest] = pair;
    if (values.has(key)) return `the ${name} step sets ${key} twice`;
    if (!/^\|[-+]?[ \t]*(?:#.*)?$/.test(rest)) {
      const value = scalarOf(rest);
      if (value === null) return `the ${name} step's ${key} cannot be read`;
      values.set(key, value);
      continue;
    }
    const block: string[] = [];
    while (i + 1 < lines.length && (!lines[i + 1].trim() || indentOf(lines[i + 1]) > valueIndent)) {
      i += 1;
      if (lines[i].trim()) block.push(lines[i].trim());
    }
    values.set(key, block);
  }
  return values;
};

// The labels of `runs-on: <label>` or `runs-on: [a, b]`, each plain or
// quoted; null for anything else (a block list, a mapping, an expression).
const labelsOf = (rest: string): string[] | null => {
  const flow = /^\[([^\]]*)\][ \t]*(?:#.*)?$/.exec(rest);
  const items = flow ? flow[1].split(',').map((item) => scalarOf(item.trim())) : [scalarOf(rest)];
  if (items.some((l) => l === null)) return null;
  const labels = items as string[];
  return isRunner(labels) ? labels : null;
};

// The runs-on of the job holding line `at`: that job's keys are the lines at
// one indent below its name, itself one indent below `jobs:`.
const runsOnOf = (lines: string[], at: number, name: 'build' | 'publish'): string[] | string => {
  const jobs = lines.findIndex((l) => /^jobs:[ \t]*(?:#.*)?$/.test(l));
  const first = lines.findIndex((l, i) => i > jobs && !skipped(l));
  if (jobs === -1 || first === -1 || first > at) return `the ${name} step is not in a job`;
  const jobIndent = indentOf(lines[first]);
  let header = at;
  while (header > first && (skipped(lines[header]) || indentOf(lines[header]) !== jobIndent)) header -= 1;
  const keys: string[] = [];
  let keyIndent = -1;
  for (let i = header + 1; i < lines.length; i++) {
    if (skipped(lines[i])) continue;
    if (indentOf(lines[i]) <= jobIndent) break;
    if (keyIndent === -1) keyIndent = indentOf(lines[i]);
    if (indentOf(lines[i]) === keyIndent) keys.push(lines[i].trim());
  }
  const runsOn = keys.flatMap((k) => /^runs-on:[ \t]*(.*)$/.exec(k)?.[1] ?? []);
  if (runsOn.length !== 1) return `the ${name} job sets runs-on ${runsOn.length === 0 ? 'nowhere' : 'twice'}`;
  return (
    labelsOf(runsOn[0]) ??
    `the ${name} job's runs-on is not a runner label or a [list] of them (letters, digits, . _ -, at most ${MAX_LABELS})`
  );
};

const MAX_PATHS = 20;
const pathsOf = (v: Value | undefined) => (v === undefined ? [] : typeof v === 'string' ? [v] : v).filter(Boolean);
const BUILD_KEYS = ['repo', 'docs', 'exclude', 'prototypes'];
const PUBLISH_KEYS = ['repo', 'hub'];

// The old file's inputs, or why they cannot be kept.
export const twoJobInputs = (text: string, site: Site): CallerInputs | string => {
  const lines = text.replace(/^\ufeff/, '').split(/\r?\n/);
  if (lines.some((l) => !skipped(l) && /^[ \t]*environment:/.test(l)))
    return 'it names an environment, which the reusable workflow does not set';
  const build = stepInputs(lines, 'build');
  if (typeof build === 'string') return build;
  const publish = stepInputs(lines, 'publish');
  if (typeof publish === 'string') return publish;
  const extra = [
    ...[...build.keys()].filter((k) => !BUILD_KEYS.includes(k)).map((k) => `build ${k}`),
    ...[...publish.keys()].filter((k) => !PUBLISH_KEYS.includes(k)).map((k) => `publish ${k}`),
  ];
  if (extra.length > 0) return `it sets ${extra.join(', ')}, which the reusable workflow does not take`;
  const repo = build.get('repo');
  if (typeof repo !== 'string') return 'the build step names no repo';
  const published = publish.get('repo') ?? repo;
  if (repo !== site.repo || published !== repo) return `it does not build and publish ${site.repo}`;
  const docs = build.get('docs') ?? 'docs';
  if (typeof docs !== 'string' || docs.length > 100 || (docs !== '.' && !FOLDER.test(docs)))
    return 'its docs folder cannot be read';
  const exclude = pathsOf(build.get('exclude'));
  const prototypes = pathsOf(build.get('prototypes'));
  for (const [key, list] of [
    ['exclude', exclude],
    ['prototypes', prototypes],
  ] as const) {
    if (list.length > MAX_PATHS || list.some((p) => !isExcludePattern(p)))
      return `its ${key} paths are not paths the site build takes`;
  }
  // Each step was found exactly once above.
  const builtOn = runsOnOf(lines, usesOf(lines, 'build')[0], 'build');
  if (typeof builtOn === 'string') return builtOn;
  const publishedOn = runsOnOf(lines, usesOf(lines, 'publish')[0], 'publish');
  if (typeof publishedOn === 'string') return publishedOn;
  if (!sameRunner(builtOn, publishedOn)) return 'its build and publish jobs name different runners (runs-on)';
  return { repo, docs, exclude, prototypes, runner: builtOn };
};

// Opens a pull request replacing a two-job workflow with the caller of the
// reusable workflow at the hub's commit, keeping its repo, docs folder and
// paths. A branch from an earlier run is reused when its workflow is still
// the site's or already the caller.
export const moveToReusable = async (
  site: Site,
  ctx: Ctx & { origin: string },
): Promise<{ pull: string; made: Made[] }> => {
  if (site.environment !== null)
    throw new AddSiteError(
      409,
      `${site.repo} publishes from the environment ${site.environment}, which the reusable workflow does not set`,
    );
  const { commit, product, purpose, made, gh, head, current } = await ready(site, ctx);
  if (pinsOf(current)?.style !== 'actions')
    throw gh.stop(409, `${site.workflow} on ${site.branch} does not use the two specreview actions pinned to a commit`);
  const inputs = twoJobInputs(current, site);
  if (typeof inputs === 'string') throw gh.stop(409, `${site.workflow} on ${site.branch} cannot be moved: ${inputs}`);
  const next = workflowFor(inputs, site.branch, ctx.origin, commit);
  const short = shortCommit(commit);
  const work = `specreview/reusable-${site.repo}-${short}`;
  await gh.branchAt(product, purpose, work, site.branch, head, [site.workflow]);
  const there = await gh.fileAt(product, purpose, site.workflow, work);
  const onBranch = there && exactText(there.content);
  if (onBranch !== current && onBranch !== next)
    throw gh.stop(
      409,
      `${product} already has a branch ${work} with other changes to ${site.workflow}; delete it and try again`,
    );
  await gh.write(
    product,
    purpose,
    site.workflow,
    work,
    next,
    `ci: publish docs through specreview's reusable workflow`,
  );
  const pull = await gh.pull(
    product,
    purpose,
    work,
    site.branch,
    "Publish docs through specreview's reusable workflow",
    `Replaces \`${site.workflow}\` with one job calling specreview's reusable workflow at ${commit}, the commit the docs hub runs, keeping the repo, the docs folder and any left-out or prototype paths. Requested on the admin page by ${ctx.email}.\n\nThe hub takes publishes only from that workflow, so the docs publish again once this is merged.`,
  );
  return { pull, made };
};
