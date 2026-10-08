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
  // <org>/<ticketRepo>: where the site's tickets and labels live on GitHub.
  ticketRepo: string;
  teamDomains: string[];
  approvers: string[];
  // Lowercase exact emails and @domain entries; interim until #12 moves
  // readers to the admin page.
  readers: string[];
  // How a reader sees this site's team in place of their emails.
  teamLabel: string;
};

export type HubConfig = {
  org: string;
  accessTeamDomain: string;
  accessAud: string;
  admins: string[];
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

const TOP_KEYS = new Set(['$schema', 'org', 'accessTeamDomain', 'accessAud', 'admins', 'teamLabel', 'sites']);
const SITE_KEYS = new Set(['repo', 'teamDomains', 'approvers', 'readers', 'ticketRepo', 'teamLabel']);

// Control characters, line and paragraph separators, and the bidi overrides
// and isolates that reorder text. Joiners and direction marks stay allowed:
// Persian, Indic scripts and emoji need them.
const INVISIBLE = /[\p{Cc}\p{Zl}\p{Zp}\u202a-\u202e\u2066-\u2069]/u;
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
  return RESERVED_LABELS.has(folded) ? 'must not be You or Reader' : null;
};

export const isOwner = (v: string) => OWNER.test(v);
export const isRepoName = (v: string) => NAME.test(v) && v !== '.' && v !== '..';
export const domainOfEmail = (email: string) => EMAIL.exec(email)?.[1] ?? null;

type RawSite = Record<string, unknown>;
const strings = (v: unknown) => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null);
const isEmail = (e: string) => DOMAIN.test(domainOfEmail(e) ?? '');
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
  const ticketRepo = site.ticketRepo;
  if (typeof ticketRepo !== 'string' || !isRepoName(ticketRepo)) {
    problems.push(`${at}.ticketRepo must be a lowercase repo name of the org`);
  }
  const domains = strings(site.teamDomains);
  if (!domains || domains.length === 0) problems.push(`${at}.teamDomains must be a non-empty list`);
  if (domains && domains.some((d) => !DOMAIN.test(d))) problems.push(`${at}.teamDomains has a malformed domain`);
  if (domains && new Set(domains).size !== domains.length) problems.push(`${at}.teamDomains has a duplicate`);
  if (domains && domains.some(isPublicMail)) problems.push(`${at}.teamDomains has a public mail domain`);
  // Sites sharing a ticket repo share its tickets and labels, so they must
  // have the same team: identical domain lists, aliases included.
  if (domains && typeof ticketRepo === 'string') {
    const team = [...domains].sort().join(',');
    const seen = teamsByTicketRepo.get(ticketRepo);
    if (seen !== undefined && seen !== team) problems.push(`${at} shares ${ticketRepo} with a site of another team`);
    teamsByTicketRepo.set(ticketRepo, team);
  }
  const approvers = strings(site.approvers);
  if (!approvers) problems.push(`${at}.approvers must be a list (it may be empty)`);
  if (approvers && new Set(approvers).size !== approvers.length) problems.push(`${at}.approvers has a duplicate`);
  for (const email of approvers ?? []) {
    const domain = domainOfEmail(email);
    if (!domain || !isLowerEmail(email)) problems.push(`${at}.approvers has a malformed email`);
    else if (!domains?.includes(domain)) problems.push(`${at}.approvers has an email outside the team domains`);
  }
  const label = labelProblem(site.teamLabel);
  if (label) problems.push(`${at}.teamLabel ${label}`);
  const readers = strings(site.readers);
  if (!readers) problems.push(`${at}.readers must be a list (it may be empty)`);
  if (readers && new Set(readers).size !== readers.length) problems.push(`${at}.readers has a duplicate`);
  for (const entry of readers ?? []) {
    const why = readerProblem(entry);
    if (why) problems.push(`${at}.readers entry ${JSON.stringify(entry)} ${why}`);
  }
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
  if (typeof cfg.accessTeamDomain !== 'string' || !ACCESS_TEAM.test(cfg.accessTeamDomain)) {
    problems.push('accessTeamDomain must be <team>.cloudflareaccess.com');
  }
  if (typeof cfg.accessAud !== 'string' || !/^\S{1,200}$/.test(cfg.accessAud)) {
    problems.push('accessAud is missing or malformed');
  }
  const label = labelProblem(cfg.teamLabel);
  if (label) problems.push(`teamLabel ${label}`);
  const admins = strings(cfg.admins);
  if (!admins || admins.length === 0) problems.push('admins must be a non-empty list');
  if (admins && admins.some((e) => !isLowerEmail(e))) problems.push('admins has a malformed email');
  if (admins && new Set(admins).size !== admins.length) problems.push('admins has a duplicate');
  if (!Array.isArray(cfg.sites) || cfg.sites.length === 0) return [...problems, 'sites must be a non-empty list'];
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
    admins: string[];
    teamLabel?: string;
    sites: {
      repo: string;
      teamDomains: string[];
      approvers: string[];
      readers: string[];
      ticketRepo: string;
      teamLabel?: string;
    }[];
  };
  const config: HubConfig = {
    org: cfg.org,
    accessTeamDomain: cfg.accessTeamDomain,
    accessAud: cfg.accessAud,
    admins: cfg.admins,
    sites: new Map(
      cfg.sites.map((s) => [
        s.repo,
        {
          repo: s.repo,
          key: `${cfg.org}/${s.repo}`,
          ticketRepo: `${cfg.org}/${s.ticketRepo}`,
          teamDomains: s.teamDomains,
          approvers: s.approvers,
          readers: s.readers,
          teamLabel: s.teamLabel ?? cfg.teamLabel ?? `${cfg.org} team`,
        },
      ]),
    ),
  };
  cached = { text: text ?? '', config };
  return config;
};
