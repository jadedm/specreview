import { AppError } from './http';

// One hub per org, in the org's own Cloudflare account, on the org's own
// domain; each of the org's repos is a site at /<repo>/. The config is a JSON
// string in the Worker's environment (SPECREVIEW_CONFIG), written by the CLI
// from the org's committed specreview.config.json. It is validated before
// anything else: a mistake here decides who reads and who signs off, so it
// refuses every request rather than half-working.

export type Site = {
  // The bare repo name: the URL path and the R2 prefix.
  repo: string;
  // <org>/<repo>: the database key.
  key: string;
  // <org>/<name>: where the site's tickets and labels live on GitHub. The
  // config names one (ticketRepo) or several (ticketRepos, #90); the first is
  // the default, the repo a bare ticket number in front matter is in.
  ticketRepo: string;
  ticketRepos: string[];
  teamDomains: string[];
  // People who are team individually, by exact email (#91).
  team: string[];
  // Exact emails or @domain entries (#91); an approver has the team's view.
  approvers: string[];
  // Lowercase exact emails and @domain entries; interim until #12 moves
  // readers to the admin page.
  readers: string[];
  // How a reader sees this site's team in place of their emails.
  teamLabel: string;
  // Who may publish (publish.ts): GitHub's numeric repository id (names can
  // be renamed or reused, ids cannot), the branch, the publishing workflow's
  // path, and optionally a GitHub environment the publish job must run in.
  branch: string;
  repositoryId: string;
  workflow: string;
  environment: string | null;
  // public: anyone may read the pages without signing in (#20); the API,
  // history and every write still need a sign-in.
  visibility: 'public' | 'private';
};

// The organisation's name and logo in each site's header (#33). The logo is
// stored under a key derived from its bytes, written by deploy, so a new logo
// never replaces the file a running Worker points at.
export type Brand = { name: string; logo: { key: string; type: 'image/png' | 'image/webp' } | null };

export type HubConfig = {
  org: string;
  brand: Brand | null;
  accessTeamDomain: string;
  accessAud: string;
  // The admin page's own hostname and its Access application's audience
  // (#75): the admin page is served only there, apart from the docs sites'
  // origin, which it names (docsHostname) for what it writes, such as a new
  // site's workflow. Null when the hub has none, and then there is no admin page.
  admin: { hostname: string; aud: string; docsHostname: string } | null;
  // The prototypes' own hostname and its Access application's audience
  // (#112): prototypes are served only there, apart from the docs and admin
  // origins, which it names (docsHostname) for the way back from a miss
  // (#125). Null when the hub has none.
  proto: { hostname: string; aud: string; docsHostname: string } | null;
  admins: string[];
  // GitHub's numeric id of the org: publish tokens must carry it.
  ownerId: string;
  // The repo holding this config (#57), `<org>/<name>`; the admin page opens
  // pull requests on it. Null when the config does not name it.
  configRepo: string | null;
  sites: Map<string, Site>;
};

const OWNER = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/;
const NAME = /^[a-z0-9._-]{1,100}$/;
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const ACCESS_TEAM = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;
const EMAIL = /^[^\s@]+@([^\s@]+)$/;
// A team domain makes everyone at it team on the site, and a reader domain
// lets everyone at it read; a public mail domain would open either to every
// user of that service.
const PUBLIC_MAIL = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'ymail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
  'gmx.net',
  'mail.com',
  'zoho.com',
  'yandex.com',
  'yandex.ru',
  'qq.com',
  '163.com',
  'rediffmail.com',
  'fastmail.com',
  'hey.com',
  'privaterelay.appleid.com',
  'duck.com',
  'foxmail.com',
  'mailbox.org',
  'posteo.de',
  'hanmail.net',
  'att.net',
  'comcast.net',
  'btinternet.com',
  'free.fr',
  'inbox.ru',
  'bk.ru',
  'list.ru',
  'yeah.net',
  'sohu.com',
  'aliyun.com',
  'email.com',
  // Brands the pattern below covers only under country domains.
  'windowslive.com',
  'tutanota.com',
  'tuta.com',
  '126.com',
  'sina.com',
  'sina.net',
  '163.net',
  'naver.com',
  'daum.net',
  'laposte.net',
  'rocketmail.com',
  'lycos.com',
]);
// Big providers run a domain per country (yahoo.co.in, hotmail.co.uk), so
// these are matched by name followed directly by a public suffix; a company's
// own subdomain such as mail.acme.com is not a match.
const PUBLIC_MAIL_BRANDS =
  /^(yahoo|ymail|hotmail|outlook|live|msn|windowslive|aol|gmx|yandex|mail|web|protonmail|proton|rediffmail|rediff|tutanota|tuta|zoho|icloud|me|mac|gmail|googlemail|fastmail|hey|pm|qq|163|126|sina|naver|daum|rambler|libero|orange|laposte|t-online|seznam|wp|o2|interia|rocketmail|lycos)\.(?:[a-z]{2}|(?:co|com|net|org)\.[a-z]{2})$/;
const isPublicMail = (domain: string) => PUBLIC_MAIL.has(domain) || PUBLIC_MAIL_BRANDS.test(domain);

const TOP_KEYS = new Set([
  '$schema',
  'org',
  'ownerId',
  'accessTeamDomain',
  'accessAud',
  'hostname',
  'adminHostname',
  'accessAdminAud',
  'protoHostname',
  'accessProtoAud',
  'admins',
  'teamLabel',
  'brand',
  'configRepo',
  'sites',
]);
const BRAND_KEYS = new Set(['name', 'logo']);
const LOGO_KEYS = new Set(['key', 'type']);
const LOGO_TYPE: Record<string, 'image/png' | 'image/webp'> = { png: 'image/png', webp: 'image/webp' };
export const LOGO_KEY = /^_brand\/logo-[0-9a-f]{64}\.(png|webp)$/;
// A site's ticket repos (#90): ticketRepo, one name, or ticketRepos, 1 to 10
// unique names, never both. Valid names only, so the team check below sees
// only real repos.
export const MAX_TICKET_REPOS = 10;
const ticketReposIn = (site: Record<string, unknown>, at: string, problems: string[]): string[] => {
  const one = site.ticketRepo;
  const many = site.ticketRepos;
  if (one !== undefined && many !== undefined) {
    problems.push(`${at} has both ticketRepo and ticketRepos; keep one`);
    return [];
  }
  if (many === undefined) {
    if (typeof one === 'string' && isRepoName(one)) return [one];
    problems.push(`${at}.ticketRepo must be a lowercase repo name of the org`);
    return [];
  }
  const list = strings(many);
  if (!list || list.length === 0 || list.length > MAX_TICKET_REPOS) {
    problems.push(`${at}.ticketRepos must be a list of 1 to ${MAX_TICKET_REPOS} repo names`);
    return [];
  }
  const bad = list.findIndex((r) => !isRepoName(r));
  if (bad >= 0) problems.push(`${at}.ticketRepos[${bad}] must be a lowercase repo name of the org`);
  if (new Set(list).size !== list.length) problems.push(`${at}.ticketRepos has a duplicate`);
  return bad >= 0 ? [] : list;
};

const SITE_KEYS = new Set([
  'repo',
  'teamDomains',
  'team',
  'approvers',
  'readers',
  'ticketRepo',
  'ticketRepos',
  'teamLabel',
  'branch',
  'repositoryId',
  'workflow',
  'environment',
  'visibility',
]);
// GitHub's numeric ids, as its tokens carry them: decimal strings.
const GITHUB_ID = /^[1-9][0-9]{0,19}$/;
// A plain branch name; no refs/ prefix, no .., no trailing dot or slash.
const BRANCH = /^(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const WORKFLOW = /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/;
const ENVIRONMENT = /^[A-Za-z0-9 ._-]{1,255}$/;

// Control, unassigned, private-use and lone surrogate characters, line and
// paragraph separators, interlinear annotations, and the bidi overrides and
// isolates that reorder text. Joiners and direction marks stay allowed:
// Persian, Indic scripts and emoji need them.
const INVISIBLE = /[\p{Cc}\p{Cn}\p{Co}\p{Cs}\p{Zl}\p{Zp}\u202a-\u202e\u2066-\u2069\ufff9-\ufffb]/u;
// What does not show on its own: marks, spaces, default-ignorable characters
// (fillers, joiners, variation selectors) and the blank Braille cell.
const BLANK = /[\p{Default_Ignorable_Code_Point}\p{M}\s\u2800]/gu;
// The names readers see for themselves and for each other.
const RESERVED_LABELS = new Set(['you', 'reader']);

// Shown to readers in place of a team member's email, so it must not be one.
const labelProblem = (v: unknown): string | null => {
  if (v === undefined) return null;
  const length = typeof v === 'string' ? [...v].length : 0;
  if (typeof v !== 'string' || length < 1 || length > 40) return 'must be 1 to 40 characters';
  if (INVISIBLE.test(v) || v.trim() !== v) return 'must have no control characters or outer spaces';
  if (v.replace(BLANK, '') === '') return 'must show something';
  // NFKC folds lookalikes such as the fullwidth at sign and letters.
  const folded = v.normalize('NFKC').toLowerCase();
  if (folded.includes('@')) return 'must not contain @';
  // Invisible characters do not change how a name reads: "You" with a
  // zero-width space is still You. Lookalike letters from other scripts
  // (a Cyrillic o) are not caught.
  return RESERVED_LABELS.has(folded.replace(BLANK, '')) ? 'must not be You or Reader' : null;
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// The Worker's shape, as deploy writes it: the logo is already a stored key.
const brandProblems = (v: unknown): string[] => {
  if (v === undefined) return [];
  if (!isPlainObject(v)) return ['brand must be an object'];
  const problems = Object.keys(v)
    .filter((k) => !BRAND_KEYS.has(k))
    .map((k) => `unknown key brand.${k}`);
  const name = v.name === undefined ? 'is required' : labelProblem(v.name);
  if (name) problems.push(`brand.name ${name}`);
  if (v.logo === undefined) return problems;
  if (!isPlainObject(v.logo)) return [...problems, 'brand.logo must be an object'];
  const logo = v.logo;
  problems.push(
    ...Object.keys(logo)
      .filter((k) => !LOGO_KEYS.has(k))
      .map((k) => `unknown key brand.logo.${k}`),
  );
  const ext = typeof logo.key === 'string' ? LOGO_KEY.exec(logo.key)?.[1] : undefined;
  if (!ext) return [...problems, 'brand.logo.key must be _brand/logo-<sha256>.png or .webp'];
  if (logo.type !== LOGO_TYPE[ext]) problems.push(`brand.logo.type must be ${LOGO_TYPE[ext]} for a .${ext} key`);
  return problems;
};

export const isOwner = (v: string) => OWNER.test(v);
export const isRepoName = (v: string) => NAME.test(v) && v !== '.' && v !== '..';
export const domainOfEmail = (email: string) => EMAIL.exec(email)?.[1] ?? null;

type RawSite = Record<string, unknown>;
const strings = (v: unknown) => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null);
// An entry's part before the @ (#135): what an address may hold unquoted
// (RFC 5322 atext and dots), with no leading, trailing or doubled dot. Only
// for entries in the config: a signed-in email is read by domainOfEmail as
// before, so this rule turns no one away who is let in today.
// Letters and digits of any script count too (RFC 6531), as the rule before
// this one let them through.
const LOCAL = /^[\p{L}\p{M}\p{N}!#$%&'*+/=?^_`{|}~-]+(\.[\p{L}\p{M}\p{N}!#$%&'*+/=?^_`{|}~-]+)*$/u;
const isEmail = (e: string) => {
  const at = e.lastIndexOf('@');
  // At most 64 before the @ and 254 in all, as an address can be.
  return at > 0 && at <= 64 && e.length <= 254 && LOCAL.test(e.slice(0, at)) && DOMAIN.test(domainOfEmail(e) ?? '');
};
const isLowerEmail = (e: string) => isEmail(e) && e === e.toLowerCase() && e.trim() === e;

const readerProblem = (entry: string): string | null => {
  if (entry !== entry.trim() || entry !== entry.toLowerCase()) return 'must be lowercase with no spaces';
  if (entry.startsWith('@')) {
    const domain = entry.slice(1);
    if (!DOMAIN.test(domain)) return 'is a malformed @domain';
    return isPublicMail(domain) ? 'is a public mail domain' : null;
  }
  return isEmail(entry) ? null : 'is not an email or @domain';
};

const siteProblems = (site: RawSite, at: string, teamsByTicketRepo: Map<string, string>): string[] => {
  const problems: string[] = [];
  for (const key of Object.keys(site)) if (!SITE_KEYS.has(key)) problems.push(`${at} has unknown key ${key}`);
  const repo = site.repo;
  if (typeof repo !== 'string' || !isRepoName(repo)) problems.push(`${at}.repo must be a lowercase repo name`);
  // /_publish is the hub's own; a repo starting with _ could collide.
  if (typeof repo === 'string' && repo.startsWith('_')) problems.push(`${at}.repo may not start with _`);
  const branchOk =
    typeof site.branch === 'string' &&
    BRANCH.test(site.branch) &&
    !site.branch.endsWith('.') &&
    !site.branch.startsWith('refs/');
  if (!branchOk) {
    problems.push(`${at}.branch must be a branch name`);
  }
  if (typeof site.repositoryId !== 'string' || !GITHUB_ID.test(site.repositoryId)) {
    problems.push(`${at}.repositoryId must be GitHub's numeric repository id, as a string`);
  }
  if (typeof site.workflow !== 'string' || !WORKFLOW.test(site.workflow)) {
    problems.push(`${at}.workflow must be .github/workflows/<file>.yml`);
  }
  if (site.visibility !== undefined && site.visibility !== 'public' && site.visibility !== 'private') {
    problems.push(`${at}.visibility must be public or private`);
  }
  if (site.environment !== undefined && (typeof site.environment !== 'string' || !ENVIRONMENT.test(site.environment))) {
    problems.push(`${at}.environment must be a GitHub environment name`);
  }
  const ticketRepos = ticketReposIn(site, at, problems);
  const domains = strings(site.teamDomains);
  if (!domains || domains.length === 0) problems.push(`${at}.teamDomains must be a non-empty list`);
  if (domains && domains.some((d) => !DOMAIN.test(d))) problems.push(`${at}.teamDomains has a malformed domain`);
  if (domains && new Set(domains).size !== domains.length) problems.push(`${at}.teamDomains has a duplicate`);
  if (domains && domains.some(isPublicMail)) problems.push(`${at}.teamDomains has a public mail domain`);
  // Team by exact email (#91): any domain, as readers may be.
  const members = site.team === undefined ? [] : strings(site.team);
  if (!members) problems.push(`${at}.team must be a list of emails`);
  if (members && new Set(members).size !== members.length) problems.push(`${at}.team has a duplicate`);
  (members ?? []).forEach((email, i) => {
    if (!isLowerEmail(email)) problems.push(`${at}.team[${i}] must be a lowercase email`);
  });
  // Sites sharing a ticket repo share its tickets and labels, so they must
  // have the same team: identical domain lists, aliases included. People
  // named in team or as approvers see only their own site's tickets.
  const team = domains && [...domains].sort().join(',');
  for (const ticketRepo of team ? ticketRepos : []) {
    const seen = teamsByTicketRepo.get(ticketRepo);
    if (seen !== undefined && seen !== team) problems.push(`${at} shares ${ticketRepo} with a site of another team`);
    teamsByTicketRepo.set(ticketRepo, team as string);
  }
  const approvers = strings(site.approvers);
  if (!approvers) problems.push(`${at}.approvers must be a list (it may be empty)`);
  if (approvers && new Set(approvers).size !== approvers.length) problems.push(`${at}.approvers has a duplicate`);
  // An exact email or a whole @domain (#91), not limited to the team domains;
  // a public mail domain is refused, as for readers.
  (approvers ?? []).forEach((entry, i) => {
    const why = readerProblem(entry);
    if (why) problems.push(`${at}.approvers[${i}] ${why}`);
  });
  const label = labelProblem(site.teamLabel);
  if (label) problems.push(`${at}.teamLabel ${label}`);
  const readers = strings(site.readers);
  if (!readers) problems.push(`${at}.readers must be a list (it may be empty)`);
  if (readers && new Set(readers).size !== readers.length) problems.push(`${at}.readers has a duplicate`);
  // By position: problems are logged, and an entry is a person's email.
  (readers ?? []).forEach((entry, i) => {
    const why = readerProblem(entry);
    if (why) problems.push(`${at}.readers[${i}] ${why}`);
  });
  return problems;
};

// Returns the problems found; empty means valid.
export const problemsIn = (raw: unknown): string[] => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return ['config is not a JSON object'];
  const cfg = raw as Record<string, unknown>;
  const problems: string[] = [];
  // A misspelt key would silently drop whatever it was meant to restrict.
  for (const key of Object.keys(cfg)) if (!TOP_KEYS.has(key)) problems.push(`unknown key ${key}`);
  if (typeof cfg.org !== 'string' || !isOwner(cfg.org)) problems.push('org must be a lowercase GitHub owner name');
  if (cfg.configRepo !== undefined && (typeof cfg.configRepo !== 'string' || !isRepoName(cfg.configRepo)))
    problems.push('configRepo must be the bare lowercase name of the repo holding this config');
  if (typeof cfg.ownerId !== 'string' || !GITHUB_ID.test(cfg.ownerId)) {
    problems.push("ownerId must be GitHub's numeric id of the org, as a string");
  }
  if (typeof cfg.accessTeamDomain !== 'string' || !ACCESS_TEAM.test(cfg.accessTeamDomain)) {
    problems.push('accessTeamDomain must be <team>.cloudflareaccess.com');
  }
  if (typeof cfg.accessAud !== 'string' || !/^\S{1,200}$/.test(cfg.accessAud)) {
    problems.push('accessAud is missing or malformed');
  }
  if (cfg.adminHostname !== undefined && (typeof cfg.adminHostname !== 'string' || !DOMAIN.test(cfg.adminHostname)))
    problems.push('adminHostname must be a bare lowercase hostname');
  if (cfg.protoHostname !== undefined && (typeof cfg.protoHostname !== 'string' || !DOMAIN.test(cfg.protoHostname)))
    problems.push('protoHostname must be a bare lowercase hostname');
  // Each extra hostname comes with its Access audience, and either needs the
  // docs sites' hostname (#75, #112).
  if ((cfg.adminHostname === undefined) !== (cfg.accessAdminAud === undefined))
    problems.push('adminHostname and accessAdminAud go together');
  if ((cfg.protoHostname === undefined) !== (cfg.accessProtoAud === undefined))
    problems.push('protoHostname and accessProtoAud go together');
  const extra = [cfg.adminHostname, cfg.accessAdminAud, cfg.protoHostname, cfg.accessProtoAud].some(
    (v) => v !== undefined,
  );
  if (extra !== (cfg.hostname !== undefined)) problems.push('hostname goes with adminHostname or protoHostname');
  if (cfg.hostname !== undefined && (typeof cfg.hostname !== 'string' || !DOMAIN.test(cfg.hostname)))
    problems.push('hostname must be a bare lowercase hostname');
  if (cfg.hostname !== undefined && cfg.hostname === cfg.adminHostname)
    problems.push("adminHostname must differ from the docs sites' hostname");
  if (
    cfg.accessAdminAud !== undefined &&
    (typeof cfg.accessAdminAud !== 'string' || !/^\S{1,200}$/.test(cfg.accessAdminAud))
  )
    problems.push('accessAdminAud is malformed');
  if (cfg.accessAdminAud !== undefined && cfg.accessAdminAud === cfg.accessAud)
    problems.push("accessAdminAud must be the admin hostname's own Access application, not the hub's");
  if (cfg.protoHostname !== undefined && [cfg.hostname, cfg.adminHostname].includes(cfg.protoHostname))
    problems.push('protoHostname must differ from the docs and admin hostnames');
  if (
    cfg.accessProtoAud !== undefined &&
    (typeof cfg.accessProtoAud !== 'string' || !/^\S{1,200}$/.test(cfg.accessProtoAud))
  )
    problems.push('accessProtoAud is malformed');
  if (cfg.accessProtoAud !== undefined && [cfg.accessAud, cfg.accessAdminAud].includes(cfg.accessProtoAud))
    problems.push("accessProtoAud must be the prototype hostname's own Access application");
  const label = labelProblem(cfg.teamLabel);
  if (label) problems.push(`teamLabel ${label}`);
  problems.push(...brandProblems(cfg.brand));
  const admins = strings(cfg.admins);
  if (!admins || admins.length === 0) problems.push('admins must be a non-empty list');
  if (admins && admins.some((e) => !isLowerEmail(e))) problems.push('admins has a malformed email');
  if (admins && new Set(admins).size !== admins.length) problems.push('admins has a duplicate');
  // No sites is a hub just installed (#92): sites are added on the admin page.
  if (!Array.isArray(cfg.sites)) return [...problems, 'sites must be a list'];
  const repos = new Set<string>();
  const teamsByTicketRepo = new Map<string, string>();
  (cfg.sites as unknown[]).forEach((site, i) => {
    const at = `sites[${i}]`;
    if (typeof site !== 'object' || site === null || Array.isArray(site)) {
      problems.push(`${at} is not an object`);
      return;
    }
    const repo = (site as RawSite).repo;
    if (typeof repo === 'string' && repos.has(repo)) problems.push(`${at}.repo is listed twice`);
    if (typeof repo === 'string') repos.add(repo);
    problems.push(...siteProblems(site as RawSite, at, teamsByTicketRepo));
  });
  return problems;
};

let cached: { text: string; config: HubConfig } | null = null;

export const configOf = (text: string | undefined): HubConfig => {
  if (cached && cached.text === text) return cached.config;
  const raw = (() => {
    try {
      return JSON.parse(text ?? '') as unknown;
    } catch {
      return undefined;
    }
  })();
  const problems = raw === undefined ? ['SPECREVIEW_CONFIG is missing or not JSON'] : problemsIn(raw);
  if (problems.length > 0) {
    console.error('specreview config invalid', problems.join('; '));
    throw new AppError(500, 'CONFIG_INVALID', 'The hub is not configured correctly.');
  }
  const cfg = raw as {
    org: string;
    accessTeamDomain: string;
    accessAud: string;
    hostname?: string;
    adminHostname?: string;
    accessAdminAud?: string;
    protoHostname?: string;
    accessProtoAud?: string;
    admins: string[];
    ownerId: string;
    configRepo?: string;
    teamLabel?: string;
    brand?: { name: string; logo?: { key: string; type: 'image/png' | 'image/webp' } };
    sites: {
      repo: string;
      teamDomains: string[];
      team?: string[];
      approvers: string[];
      readers: string[];
      ticketRepo?: string;
      ticketRepos?: string[];
      teamLabel?: string;
      branch: string;
      repositoryId: string;
      workflow: string;
      environment?: string;
      visibility?: 'public' | 'private';
    }[];
  };
  const config: HubConfig = {
    org: cfg.org,
    brand: cfg.brand ? { name: cfg.brand.name, logo: cfg.brand.logo ?? null } : null,
    accessTeamDomain: cfg.accessTeamDomain,
    accessAud: cfg.accessAud,
    admin:
      cfg.hostname && cfg.adminHostname && cfg.accessAdminAud
        ? { hostname: cfg.adminHostname, aud: cfg.accessAdminAud, docsHostname: cfg.hostname }
        : null,
    proto:
      cfg.hostname && cfg.protoHostname && cfg.accessProtoAud
        ? { hostname: cfg.protoHostname, aud: cfg.accessProtoAud, docsHostname: cfg.hostname }
        : null,
    admins: cfg.admins,
    ownerId: cfg.ownerId,
    configRepo: cfg.configRepo ? `${cfg.org}/${cfg.configRepo}` : null,
    sites: new Map(
      cfg.sites.map((s) => [
        s.repo,
        {
          repo: s.repo,
          key: `${cfg.org}/${s.repo}`,
          ticketRepo: `${cfg.org}/${(s.ticketRepos ?? [s.ticketRepo as string])[0]}`,
          ticketRepos: (s.ticketRepos ?? [s.ticketRepo as string]).map((r) => `${cfg.org}/${r}`),
          teamDomains: s.teamDomains,
          team: s.team ?? [],
          approvers: s.approvers,
          readers: s.readers,
          teamLabel: s.teamLabel ?? cfg.teamLabel ?? `${cfg.org} team`,
          branch: s.branch,
          repositoryId: s.repositoryId,
          workflow: s.workflow,
          environment: s.environment ?? null,
          visibility: s.visibility ?? 'private',
        },
      ]),
    ),
  };
  cached = { text: text ?? '', config };
  return config;
};
