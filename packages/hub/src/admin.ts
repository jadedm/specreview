import { changeAccess, listsIn, readConfig, type AccessChange, type Outcome } from './access-edit';
import { AddSiteError, addSite, inputProblem, listBranches, type SiteInput } from './add-site';
import { pendingFor, type List } from './pending';
import { isRepoName, type HubConfig } from './config';
import type { Deps } from './ctx';
import type { Env } from './env';
import { forgetStoredAuth } from './github-auth';
import { AppError, readLimited } from './http';
import { escapeHtml, page } from './root';
import { seal } from './seal';
import { findApp, forgetApp, saveApp, type Found } from './stored-app';
import { API, githubFetch } from './github-fetch';

// The hub's admin page (#56), for the config's admins only: create the
// organisation's GitHub App with GitHub's app-manifest flow, see where it is
// installed, or forget it. Access covers these paths like every other but
// /_publish/* and public sites' pages; the hub checks the admin itself.

const STATE_TTL_MS = 60 * 60_000;
const STATES_PER_ADMIN = 10;
const INSTALLED_WAIT_MS = 3_000;
const BACK = '<p><a href="/_admin/">Back to the admin page</a></p>';

type Admin = { request: Request; url: URL; env: Env; config: HubConfig; email: string; deps: Deps };
type Route = { method: string; run: (a: Admin) => Promise<Response> };

const nameOf = (config: HubConfig) => escapeHtml(config.brand?.name ?? config.org);
const say = (a: Admin, status: number, title: string, body: string) =>
  page(status, nameOf(a.config), `<h1>${escapeHtml(title)}</h1>${body}${BACK}`, false);

const envApp = (env: Env) => Boolean(env.GITHUB_APP_ID?.trim() || env.GITHUB_APP_PRIVATE_KEY);
const hubKeySet = (env: Env) =>
  seal(env.SPECREVIEW_KEY, 'probe', '').then(
    () => true,
    () => false,
  );

// GitHub caps app names at 34 characters; its form lets the admin change one
// that is taken.
export const manifestFor = (config: HubConfig, origin: string) => ({
  name: `specreview ${config.org}`.slice(0, 34),
  url: origin,
  hook_attributes: { url: origin, active: false },
  redirect_url: `${origin}/_admin/github/created`,
  public: false,
  // Tickets and labels (Issues); adding a site opens pull requests that add a
  // workflow and change the config (#57).
  default_permissions: {
    issues: 'write',
    metadata: 'read',
    contents: 'write',
    pull_requests: 'write',
    workflows: 'write',
  },
  default_events: [],
});

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

// Single use, an hour long, the admin's own; an admin keeps at most ten.
const newState = async (env: Env, email: string) => {
  const state = hex(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM admin_states WHERE expires_at <= ?').bind(now),
    env.DB.prepare(
      'DELETE FROM admin_states WHERE email = ? AND state NOT IN (SELECT state FROM admin_states WHERE email = ? ORDER BY expires_at DESC LIMIT ?)',
    ).bind(email, email, STATES_PER_ADMIN - 1),
    env.DB.prepare('INSERT INTO admin_states (state, email, expires_at) VALUES (?, ?, ?)').bind(
      state,
      email,
      now + STATE_TTL_MS,
    ),
  ]);
  return state;
};

const takeState = async (env: Env, email: string, state: string) =>
  (await env.DB.prepare('DELETE FROM admin_states WHERE state = ? AND email = ? AND expires_at > ? RETURNING state')
    .bind(state, email, Date.now())
    .first()) !== null;

const within = <T>(p: Promise<T>, fallback: T, wait = INSTALLED_WAIT_MS) =>
  Promise.race([p.catch(() => fallback), new Promise<T>((r) => setTimeout(() => r(fallback), wait))]);

const ticketRepos = (config: HubConfig) => [...new Set([...config.sites.values()].map((s) => s.ticketRepo))];

const installations = async (a: Admin) => {
  const repos = ticketRepos(a.config);
  const states = await Promise.all(
    repos.map((r) => within(a.deps.github.installed?.(r) ?? Promise.resolve(null), null)),
  );
  const word = (s: boolean | null) => (s === null ? 'could not check' : s ? 'installed' : 'not installed');
  const items = repos.map(
    (r, i) =>
      `<li><span class="site"><span class="title">${escapeHtml(r)}</span><span class="meta">${word(states[i])}</span></span></li>`,
  );
  return `<h2>Ticket repos</h2><ul>${items.join('')}</ul>`;
};

const FORGET =
  '<form method="post" action="/_admin/github/forget"><button class="quiet" type="submit">Forget this app</button></form>';

const createForm = async (a: Admin) => {
  const state = await newState(a.env, a.email);
  const manifest = escapeHtml(JSON.stringify(manifestFor(a.config, a.url.origin)));
  return `<p>The hub reads tickets and sets labels as a GitHub App that ${escapeHtml(a.config.org)} owns. Create it on GitHub, where you can change its name, then install it on the repos it should use.</p><form method="post" action="https://github.com/organizations/${encodeURIComponent(a.config.org)}/settings/apps/new?state=${state}"><input type="hidden" name="manifest" value="${manifest}"><button type="submit">Create the app on GitHub</button></form>`;
};

const dateOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const bodyFor = async (a: Admin, found: Found) => {
  if (envApp(a.env))
    return `<p>This hub uses the GitHub App set in its Worker secrets (GITHUB_APP_ID). To manage the app from here instead, remove those secrets.</p>${await installations(a)}`;
  if (found.kind === 'locked')
    return `<p>The app ${escapeHtml(found.app.slug)} is stored, but this hub's key no longer opens it (${escapeHtml(found.why)}). Forget it, delete it on GitHub, and create a new one.</p>${FORGET}`;
  if (found.kind === 'app') {
    const { slug, createdBy, createdAt } = found.app;
    return `<p>The hub uses the GitHub App <strong>${escapeHtml(slug)}</strong>, created by ${escapeHtml(createdBy)} on ${dateOf(createdAt)}.</p><p><a href="https://github.com/apps/${encodeURIComponent(slug)}/installations/new">Choose the repos it is installed on</a></p>${await installations(a)}${FORGET}`;
  }
  if (!(await hubKeySet(a.env)))
    return '<p>The hub key is not set yet. Deploy the hub once (the apply workflow does this), then come back here.</p>';
  return createForm(a);
};

// Adding a site (#57) needs the app, the repo holding the config, and the
// commit the hub runs (for the workflow's pins).
// Listing a large organisation's repos takes a page at a time.
const LISTS_WAIT_MS = 10_000;
const INTRO =
  '<h2>Add a site</h2><p>The app opens two pull requests: one adding the site to the config, one adding the docs workflow to the repo.</p>';

// Adding a site (#57) needs the app, the repo holding the config, and the
// commit the hub runs (for the workflow's pins). The form offers lists from
// GitHub (#63) in two steps, since the page runs no script: the repo, then a
// form with its branches. The lists only help; the post is checked as before.
const sitesFor = async (a: Admin, found: Found) => {
  const listed = [...a.config.sites.keys()]
    .map((r) => `<li><span class="site"><span class="title">${escapeHtml(r)}</span></span></li>`)
    .join('');
  const current = `<h2>Sites</h2><ul>${listed}</ul>`;
  const missing = [
    !envApp(a.env) && found.kind !== 'app' && 'a GitHub App (above)',
    !a.config.configRepo && '<code>configRepo</code> in the config (the repo holding it)',
    !a.env.SPECREVIEW_COMMIT && 'a real commit in <code>specreview.commit</code>, then a deploy',
  ].filter(Boolean);
  if (missing.length > 0)
    return `${current}<p class="note">To add a site from here, the hub needs ${missing.join(', ')}.</p>`;
  const chosen = a.url.searchParams.get('repo');
  return `${current}${INTRO}${chosen === null ? await chooseRepo(a, '') : await siteForm(a, chosen.trim().toLowerCase())}`;
};

// Every repo the app reaches, and those that can become a site: less sites
// and the repo holding the config.
const reachable = (a: Admin) =>
  within(a.deps.github.repos?.(a.config.org) ?? Promise.resolve(null), null, LISTS_WAIT_MS);
const configName = (a: Admin) => a.config.configRepo?.split('/')[1];
const candidates = async (a: Admin) => {
  const all = await reachable(a);
  if (!Array.isArray(all)) return all;
  return all.filter(
    (r) => !a.config.sites.has(r) && r !== configName(a) && isRepoName(r) && !r.startsWith('_') && !r.startsWith('.'),
  );
};

const chooseRepo = async (a: Admin, note: string) => {
  const repos = await candidates(a);
  const said = note ? `<p class="note">${escapeHtml(note)}</p>` : '';
  if (!Array.isArray(repos))
    return (
      said +
      textForm(
        a,
        '',
        repos === 'too-many'
          ? 'There are too many repos to list; type the names.'
          : 'GitHub did not list the repos in time, or could not; type the names.',
      )
    );
  if (repos.length === 0)
    return `${said}<p class="note">Every repo the app can reach is already a site. Install the app on another repo first.</p>`;
  return `${said}<form method="get" action="/_admin/">${select('repo', 'Repo', repos, '', `The repo whose docs to publish, in ${escapeHtml(a.config.org)}`)}<button type="submit">Next</button></form>`;
};

const siteForm = async (a: Admin, repo: string) => {
  if (!isRepoName(repo) || repo.startsWith('_')) return chooseRepo(a, 'That is not a repo name.');
  if (a.config.sites.has(repo)) return chooseRepo(a, `${repo} is already a site.`);
  if (repo === configName(a)) return chooseRepo(a, 'The repo holding the config cannot be a docs site.');
  // Asked together: a slow GitHub costs one wait, not two.
  const [branches, all] = await Promise.all([
    within(listBranches(a.deps.github, `${a.config.org}/${repo}`), null, LISTS_WAIT_MS),
    reachable(a),
  ]);
  if (branches === 'missing')
    return chooseRepo(a, `GitHub does not show ${repo} to the app. Install the app on it, or choose another.`);
  if (!branches) return textForm(a, repo, 'GitHub did not list the branches in time, or could not; type them.');
  // Any repo the app reaches can hold the tickets, sites and the config repo included.
  const ticketRepos = Array.isArray(all)
    ? [...new Set([repo, ...all, ...[...a.config.sites.values()].map((s) => s.ticketRepo.split('/')[1])])].sort()
    : null;
  const branch = Array.isArray(branches.names)
    ? select('branch', 'Branch', branches.names, branches.defaultBranch, 'Publishes from this branch')
    : field('branch', 'Branch', branches.defaultBranch, 'Publishes from this branch');
  const tickets = ticketRepos
    ? select('ticketRepo', 'Ticket repo', ticketRepos, repo, 'Where its tickets are')
    : field('ticketRepo', 'Ticket repo', repo, 'Where its tickets are');
  return `<form method="post" action="/_admin/sites"><p><strong>${escapeHtml(repo)}</strong> <a href="/_admin/">Choose another repo</a></p><input type="hidden" name="repo" value="${escapeHtml(repo)}">${branch}${field('docs', 'Docs folder', 'docs', '. for the whole repo, when it holds only pages and images')}${field('exclude', 'Leave out', '', 'Paths in the docs folder not to publish, comma separated; * and ** are wildcards')}${tickets}${suggest('teamDomain', 'Team domain', teamDomains(a), "Everyone at this domain is the site's team; pick one or type another")}<button type="submit">Open the pull requests</button></form>`;
};

// Today's form, typed: when GitHub cannot list.
const textForm = (a: Admin, repo: string, note: string) =>
  `<p class="note">${escapeHtml(note)}</p><form method="post" action="/_admin/sites">${field('repo', 'Repo', repo, `The repo whose docs to publish, in ${escapeHtml(a.config.org)}`)}${field('branch', 'Branch', '', "Publishes from this branch; empty for the repo's default")}${field('docs', 'Docs folder', 'docs', '. for the whole repo, when it holds only pages and images')}${field('exclude', 'Leave out', '', 'Paths in the docs folder not to publish, comma separated; * and ** are wildcards')}${field('ticketRepo', 'Ticket repo', '', 'Where its tickets are; empty for the same repo')}${field('teamDomain', 'Team domain', teamDomains(a)[0], "Everyone at this domain is the site's team")}<button type="submit">Open the pull requests</button></form>`;

// The admin's own domain first, then the sites' team domains.
const teamDomains = (a: Admin) => [
  ...new Set(
    [a.email.split('@')[1] ?? '', ...[...a.config.sites.values()].flatMap((s) => s.teamDomains)].filter(Boolean),
  ),
];

// Values are escaped here; labels and hints are the page's own text.
const field = (name: string, label: string, value: string, hint: string) =>
  `<p><label>${label}<br><input name="${name}" value="${escapeHtml(value)}" autocomplete="off"></label>${hint ? `<br><span class="note">${hint}</span>` : ''}</p>`;

// A text box with suggestions: the known values, and any other may be typed.
const suggest = (name: string, label: string, options: string[], hint: string) =>
  `<p><label>${label}<br><input name="${name}" value="${escapeHtml(options[0] ?? '')}" list="${name}-options" autocomplete="off"></label><datalist id="${name}-options">${options.map((o) => `<option value="${escapeHtml(o)}">`).join('')}</datalist>${hint ? `<br><span class="note">${hint}</span>` : ''}</p>`;

const select = (name: string, label: string, options: string[], chosen: string, hint: string) =>
  `<p><label>${label}<br><select name="${name}">${options.map((o) => `<option value="${escapeHtml(o)}"${o === chosen ? ' selected' : ''}>${escapeHtml(o)}</option>`).join('')}</select></label>${hint ? `<br><span class="note">${hint}</span>` : ''}</p>`;

// Who reads and approves each site (#12): the lists as committed in the
// config repo, which is where they live, marked against what the hub runs.
const accessFor = async (a: Admin, found: Found) => {
  const configRepo = a.config.configRepo;
  if (!configRepo || (!envApp(a.env) && found.kind !== 'app')) return '';
  const file = await within(readConfig(a.deps.github, configRepo), null, LISTS_WAIT_MS);
  const history = file
    ? ` <a href="https://github.com/${escapeHtml(configRepo)}/commits/${file.branch.split('/').map(encodeURIComponent).join('/')}/specreview.config.json">History</a>`
    : '';
  const intro = `<h2>Who reads and approves</h2><p class="note">Each change is a commit to ${escapeHtml(configRepo)}; its apply workflow carries it to the sign-in and the hub in a couple of minutes, so someone added may be refused until then. A removal takes effect here at once.${history}</p>`;
  if (!file)
    return `${intro}<p class="note">The hub could not read the config from GitHub, so the lists cannot be changed right now.</p>`;
  const sites = await Promise.all(
    [...a.config.sites.values()].map(async (site) => {
      const git = listsIn(file.config, site.repo) ?? { readers: [], approvers: [], team: [] };
      const removed = await pendingFor(a.env, site.key).catch(() => null);
      if (!removed)
        return `<h2>${escapeHtml(site.repo)}</h2><p class="note">The hub cannot read its list of removals right now, so these lists cannot be changed.</p>`;
      const lists = (['readers', 'approvers', 'team'] as const).map((list) => {
        const live = site[list];
        const refused = new Map(removed.filter((r) => r.list === list).map((r) => [r.entry, r.removedAt]));
        const committed = git[list];
        const rows = [
          // In git: live, or added and not yet deployed; refused here if a removal still stands.
          ...committed.map((entry) =>
            entryRow(
              site.repo,
              list,
              entry,
              refused.has(entry)
                ? 'refused here by an earlier removal'
                : live.includes(entry)
                  ? ''
                  : 'added, deploy pending',
              { remove: true, restoreAt: refused.get(entry) },
            ),
          ),
          // Deployed but gone from git: refused here, or removed in git and not yet deployed.
          ...live
            .filter((entry) => !committed.includes(entry))
            .map((entry) =>
              refused.has(entry)
                ? entryRow(site.repo, list, entry, 'removed, deploy pending', { addBack: true })
                : entryRow(site.repo, list, entry, 'removed in git, deploy pending', { remove: true }),
            ),
          // A removal listed nowhere any more is not shown (#67): it lets no one
          // in, and is kept so that a config listing them again cannot either.
        ];
        const title = { readers: 'Readers', approvers: 'Approvers', team: 'Team members' }[list];
        const hint = {
          readers: 'name@company.com, or @company.com for everyone there',
          approvers: 'name@company.com, or @company.com for everyone there; approvers see what the team sees',
          team: `name@company.com, seeing what the team sees (everyone at ${site.teamDomains.join(' or ')} already does)`,
        }[list];
        return `<p><strong>${title}</strong></p><ul>${rows.join('') || '<li><span class="site"><span class="meta">None</span></span></li>'}</ul><form method="post" action="/_admin/access"><input type="hidden" name="site" value="${escapeHtml(site.repo)}"><input type="hidden" name="list" value="${list}"><input type="hidden" name="action" value="add"><p><label>Add ${{ readers: 'a reader', approvers: 'an approver', team: 'a team member' }[list]}<br><input name="entry" autocomplete="off"></label><br><span class="note">${escapeHtml(hint)}</span></p><button class="quiet" type="submit">Add</button></form>`;
      });
      return `<h2>${escapeHtml(site.repo)}</h2>${lists.join('')}`;
    }),
  );
  return intro + sites.join('');
};

// Add back commits the entry again; Let back in only clears the removal shown,
// named by its time so a newer one is not cleared (#67).
const entryForm = (
  repo: string,
  list: List,
  entry: string,
  action: 'add' | 'remove' | 'restore',
  label: string,
  removedAt?: number,
) =>
  `<form class="inline" method="post" action="/_admin/access"><input type="hidden" name="site" value="${escapeHtml(repo)}"><input type="hidden" name="list" value="${list}"><input type="hidden" name="action" value="${action}"><input type="hidden" name="entry" value="${escapeHtml(entry)}">${removedAt === undefined ? '' : `<input type="hidden" name="removed_at" value="${removedAt}">`}<button class="quiet" type="submit">${label}</button></form>`;

const entryRow = (
  repo: string,
  list: List,
  entry: string,
  note: string,
  can: { remove?: boolean; restoreAt?: number; addBack?: boolean },
) => {
  const buttons = `${can.addBack ? entryForm(repo, list, entry, 'add', 'Add back') : ''}${can.restoreAt === undefined ? '' : entryForm(repo, list, entry, 'restore', 'Let back in', can.restoreAt)}${can.remove ? entryForm(repo, list, entry, 'remove', 'Remove') : ''}`;
  return `<li><span class="row"><span><span class="title">${escapeHtml(entry)}</span>${note ? `<span class="meta">${note}</span>` : ''}</span><span>${buttons}</span></span></li>`;
};

// The admin page is served only with an admin hostname, which names the docs
// hostname too (#75); never guess it from where this request came.
const docsHostnameOf = (a: Admin) => {
  if (!a.config.admin) throw new AppError(404, 'NOT_FOUND');
  return a.config.admin.docsHostname;
};

const accessPost = async (a: Admin) => {
  if (a.request.headers.get('origin') !== a.url.origin) throw new AppError(403, 'BAD_ORIGIN');
  const form = await formOf(a.request);
  const value = (k: string) => (form.get(k) ?? '').trim();
  const list = value('list');
  const action = value('action');
  const removedAt = /^\d{1,15}$/.test(value('removed_at')) ? Number(value('removed_at')) : undefined;
  const change = { site: value('site'), list, action, entry: value('entry').toLowerCase(), removedAt };
  const shaped =
    a.config.sites.has(change.site) &&
    (list === 'readers' || list === 'approvers' || list === 'team') &&
    (action === 'add' || action === 'remove' || action === 'restore') &&
    change.entry.length > 0 &&
    change.entry.length <= 254;
  if (!shaped) return say(a, 400, 'Check the form', '<p>A site, a list and an entry are needed.</p>');
  if (action === 'restore' && removedAt === undefined)
    return say(a, 400, 'Check the form', '<p>Reload the admin page and try again.</p>');
  const outcome = await changeAccess(change as AccessChange, {
    config: a.config,
    env: a.env,
    auth: a.deps.github,
    email: a.email,
  });
  const who = `${escapeHtml(change.entry)} ${action === 'add' ? 'added to' : 'removed from'} ${escapeHtml(change.site)}'s ${list}`;
  const answers: Record<Outcome['kind'], () => Promise<Response>> = {
    done: () =>
      say(
        a,
        200,
        action === 'add' ? 'Added' : 'Removed',
        `<p>${outcome.kind === 'done' && outcome.note ? escapeHtml(outcome.note) : `${who}. The apply workflow deploys it in a couple of minutes.${action === 'remove' ? ' The hub refuses them from now.' : ''}`}</p>${outcome.kind === 'done' && outcome.still ? `<p class="note">They still ${{ readers: 'read', approvers: 'approve', team: 'see what the team sees' }[list as 'readers' | 'approvers' | 'team']} through ${escapeHtml(outcome.still)}.</p>` : ''}${outcome.kind === 'done' && outcome.keeps ? `<p class="note">They keep ${{ reader: 'reading', team: 'the team&#39;s view', approver: 'approving', none: '' }[outcome.keeps]} here through another entry in the config.</p>` : ''}${outcome.kind === 'done' && outcome.refused ? `<p class="note">${outcome.refused === true ? 'A removal still refuses them here; the admin page offers Let back in.' : 'The hub could not check for a removal; reload the admin page to see whether one still refuses them.'}</p>` : ''}`,
      ),
    unchanged: () =>
      say(a, 200, 'Nothing to change', `<p>${escapeHtml(outcome.kind === 'unchanged' ? outcome.why : '')}.</p>`),
    refused: () =>
      say(
        a,
        outcome.kind === 'refused' ? outcome.status : 400,
        'Not changed',
        `<p>${escapeHtml(outcome.kind === 'refused' ? outcome.why : '')}.</p>`,
      ),
    standing: () =>
      say(
        a,
        502,
        'Removed here, not committed',
        `<p>The hub refuses ${escapeHtml(change.entry)} on ${escapeHtml(change.site)} from now, but the change to the config did not go through cleanly: ${escapeHtml(outcome.kind === 'standing' ? outcome.why : '')}.</p><p class="note">Check the config's history, and remove them again if the commit is not there. To undo, let them back in from the admin page.</p>`,
      ),
    restored: () =>
      say(
        a,
        200,
        'Let back in',
        `<p>The hub no longer refuses ${escapeHtml(change.entry)} on ${escapeHtml(change.site)} because of an earlier removal.</p>`,
      ),
  };
  return answers[outcome.kind]();
};

const home = async (a: Admin) => {
  const found = await findApp(a.env);
  return page(
    200,
    nameOf(a.config),
    `<h1>GitHub App</h1>${await bodyFor(a, found)}${await sitesFor(a, found)}${await accessFor(a, found)}`,
    false,
    "'self' https://github.com",
  );
};

// A small form: counted as it arrives, so a large body is never held.
const MAX_FORM = 4096;
const formOf = async (request: Request) => new URLSearchParams(await readLimited(request, MAX_FORM));

const addSitePost = async (a: Admin) => {
  if (a.request.headers.get('origin') !== a.url.origin) throw new AppError(403, 'BAD_ORIGIN');
  const form = await formOf(a.request);
  const value = (k: string) => (form.get(k) ?? '').trim();
  const repo = value('repo').toLowerCase();
  const input: SiteInput = {
    repo,
    branch: value('branch'),
    docs: value('docs') || 'docs',
    ticketRepo: value('ticketRepo').toLowerCase() || repo,
    teamDomain: value('teamDomain').toLowerCase(),
    exclude: value('exclude')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean),
  };
  const problem = inputProblem(input, a.config);
  if (problem) return say(a, 400, 'Check the form', `<p>${escapeHtml(problem)}.</p>`);
  const added = await addSite(input, {
    config: a.config,
    env: a.env,
    auth: a.deps.github,
    // The docs sites' origin, where the new site's workflow publishes (#75).
    origin: `https://${docsHostnameOf(a)}`,
    email: a.email,
  }).catch((err: unknown) => {
    if (err instanceof AddSiteError) return err;
    throw err;
  });
  if (added instanceof AddSiteError) {
    const made = added.made.length
      ? `<p>Made before it stopped:</p><ul>${added.made.map((m) => `<li><span class="site"><span class="title">${escapeHtml(m.what)}</span>${m.url ? `<span class="meta"><a href="${escapeHtml(m.url)}">${escapeHtml(m.url)}</a></span>` : ''}</span></li>`).join('')}</ul><p class="note">Fix the cause and add the site again: the branch and any open pull request are reused.</p>`
      : '';
    return say(a, added.status, 'The site was not added', `<p>${escapeHtml(added.message)}.</p>${made}`);
  }
  const link = (u: string) => `<a href="${escapeHtml(u)}">${escapeHtml(u)}</a>`;
  return say(
    a,
    200,
    `Pull requests opened for ${input.repo}`,
    `<ol><li>Merge ${link(added.config)} and wait for the apply workflow to finish green.</li><li>Then merge ${link(added.product)}. Its push publishes the site at <a href="/${escapeHtml(input.repo)}/">/${escapeHtml(input.repo)}/</a>.</li></ol><p class="note">If the docs run is refused because the hub did not know the site yet, re-run it once the hub is deployed.</p>`,
  );
};

type Conversion = {
  id?: unknown;
  slug?: unknown;
  pem?: unknown;
  html_url?: unknown;
  owner?: { id?: unknown; type?: unknown; login?: unknown };
};

const convert = async (code: string) => {
  const res = await githubFetch(`${API}/app-manifests/${code}/conversions`, {
    method: 'POST',
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'specreview',
    },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!res || res.status !== 201) return { status: res?.status ?? 0 };
  return { status: 201, app: (await res.json().catch(() => ({}))) as Conversion };
};

const appSettings = (config: HubConfig, slug: string) =>
  `https://github.com/organizations/${encodeURIComponent(config.org)}/settings/apps/${encodeURIComponent(slug)}`;

const created = async (a: Admin) => {
  const code = a.url.searchParams.get('code') ?? '';
  const state = a.url.searchParams.get('state') ?? '';
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(code) || !/^[0-9a-f]{64}$/.test(state))
    return say(
      a,
      400,
      'This link is incomplete',
      "<p>It did not come from GitHub's app creation. Start again from the admin page.</p>",
    );
  // Checked before the state is spent: GitHub's code lasts an hour, so the
  // admin can fix these and open the link again.
  if (!(await hubKeySet(a.env)))
    return say(
      a,
      500,
      'The hub key is not set',
      '<p>GitHub created the app, but the hub has no key to keep it with. Deploy the hub once, then open this link again within the hour.</p>',
    );
  if (envApp(a.env) || (await findApp(a.env)).kind !== 'none')
    return say(
      a,
      409,
      'An app is already set up',
      '<p>Forget the current app on the admin page before adding another. Delete the new one on GitHub if you do not need it.</p>',
    );
  if (!(await takeState(a.env, a.email, state)))
    return say(
      a,
      400,
      'This link has expired',
      '<p>It was already used, is over an hour old, or was started by another admin. Start again from the admin page.</p>',
    );
  const { status, app } = await convert(code);
  if (!app)
    return say(
      a,
      502,
      'GitHub did not hand over the app',
      `<p>GitHub answered ${status || 'nothing'}. If the app was created, delete it on GitHub (your organisation's settings, Developer settings, GitHub Apps) and start again.</p>`,
    );
  const slug = typeof app.slug === 'string' && /^[a-z0-9-]{1,100}$/.test(app.slug) ? app.slug : null;
  const usable = typeof app.id === 'number' && slug && typeof app.pem === 'string' && app.pem.includes('PRIVATE KEY');
  if (!usable)
    return say(a, 502, 'GitHub sent an app the hub cannot use', '<p>Delete it on GitHub and start again.</p>');
  const ours = String(app.owner?.id) === a.config.ownerId && app.owner?.type === 'Organization';
  if (!ours)
    return say(
      a,
      400,
      'The app belongs to another account',
      `<p>${escapeHtml(slug)} was created under ${escapeHtml(String(app.owner?.login ?? 'another account'))}, not ${escapeHtml(a.config.org)}. Delete it on GitHub and create it from this page again.</p>`,
    );
  const saved = await saveApp(a.env, {
    appId: app.id as number,
    slug,
    privateKey: app.pem as string,
    createdBy: a.email,
    createdAt: Date.now(),
  }).catch((err: unknown) => {
    console.error('admin: the GitHub App could not be stored', err instanceof Error ? err.name : typeof err);
    return null;
  });
  // Another admin's return stored an app between the check above and here.
  if (saved === false)
    return say(
      a,
      409,
      'An app is already set up',
      `<p>Another app was stored a moment ago. <a href="${appSettings(a.config, slug)}">Delete ${escapeHtml(slug)} on GitHub</a> if you do not need it.</p>`,
    );
  if (saved === null)
    return say(
      a,
      500,
      'The hub could not keep the app',
      `<p>GitHub created ${escapeHtml(slug)}, but the hub could not store its key, and GitHub gives the key only once. <a href="${appSettings(a.config, slug)}">Delete the app on GitHub</a> and start again.</p>`,
    );
  forgetStoredAuth();
  return new Response(null, { status: 303, headers: { location: '/_admin/', 'cache-control': 'private, no-store' } });
};

// A form on our own page: the browser sends our origin; another site's form
// cannot, and the docs sites are another origin (#75).
const forget = async (a: Admin) => {
  if (a.request.headers.get('origin') !== a.url.origin) throw new AppError(403, 'BAD_ORIGIN');
  await forgetApp(a.env);
  forgetStoredAuth();
  return new Response(null, { status: 303, headers: { location: '/_admin/', 'cache-control': 'private, no-store' } });
};

const ROUTES: Record<string, Route> = {
  '/_admin/': { method: 'GET', run: home },
  '/_admin/github/created': { method: 'GET', run: created },
  '/_admin/github/forget': { method: 'POST', run: forget },
  '/_admin/sites': { method: 'POST', run: addSitePost },
  '/_admin/access': { method: 'POST', run: accessPost },
};

export const adminRoute = (pathname: string) => (Object.hasOwn(ROUTES, pathname) ? ROUTES[pathname] : null);

// A non-admin opening the page gets a page that says why and who is signed
// in (#62); posts and the GitHub return keep the JSON answer.
const notAdmin = (a: Admin) =>
  page(
    403,
    nameOf(a.config),
    `<h1>Admins only</h1><p>You're signed in as ${escapeHtml(a.email)}. Only the hub's admins can use this page.</p><p class="note"><a href="/cdn-cgi/access/logout">Sign in with another email</a>.</p>`,
    false,
  );

export const serveAdmin = async (route: Route, a: Admin): Promise<Response> => {
  const admin = a.config.admins.includes(a.email);
  if (!admin && route.run === home && a.request.method === 'GET') return notAdmin(a);
  if (!admin) throw new AppError(403, 'FORBIDDEN');
  if (a.request.method !== route.method) throw new AppError(405, 'METHOD_NOT_ALLOWED');
  return route.run(a);
};
