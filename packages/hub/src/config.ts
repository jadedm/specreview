import { AppError } from './http';

// One hub serves many sites. Its config is a JSON string in the Worker's
// environment (SPECREVIEW_CONFIG), written by the CLI from the team's
// committed specreview.config.json. It is validated before anything else:
// a mistake here decides who can read and sign off, so it refuses every
// request rather than half-working.

export type Site = {
  // Canonical lowercase owner/name: the URL prefix, database key and store prefix.
  repo: string;
  accessAud: string;
  teamDomains: string[];
  approvers: string[];
  ticketRepo: string;
};

export type HubConfig = { accessTeamDomain: string; sites: Map<string, Site> };

const OWNER = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/;
const NAME = /^[a-z0-9._-]{1,100}$/;
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const ACCESS_TEAM = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;
const EMAIL = /^[^\s@]+@([^\s@]+)$/;
// A team domain makes everyone at it team on the site; a public mail domain
// would make every user of that service team.
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
]);
const TOP_KEYS = new Set(['accessTeamDomain', 'sites']);
const SITE_KEYS = new Set(['repo', 'accessAud', 'teamDomains', 'approvers', 'ticketRepo']);
const ownerOf = (repo: string) => repo.split('/')[0];

export const isRepoKey = (value: string) => {
  const [owner, name, extra] = value.split('/');
  return extra === undefined && OWNER.test(owner ?? '') && NAME.test(name ?? '') && name !== '.' && name !== '..';
};

type Raw = {
  accessTeamDomain?: unknown;
  sites?: unknown;
};
type RawSite = Record<string, unknown>;

const strings = (v: unknown) => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null);

// Returns the problems found; empty means valid.
export const problemsIn = (raw: unknown): string[] => {
  const problems: string[] = [];
  if (typeof raw !== 'object' || raw === null) return ['config is not a JSON object'];
  const cfg = raw as Raw;
  // A misspelt key would silently drop whatever it was meant to restrict.
  for (const key of Object.keys(cfg)) if (!TOP_KEYS.has(key)) problems.push(`unknown key ${key}`);
  if (typeof cfg.accessTeamDomain !== 'string' || !ACCESS_TEAM.test(cfg.accessTeamDomain)) {
    problems.push('accessTeamDomain must be <team>.cloudflareaccess.com');
  }
  if (!Array.isArray(cfg.sites) || cfg.sites.length === 0) return [...problems, 'sites must be a non-empty list'];
  const repos = new Set<string>();
  const auds = new Set<string>();
  const teamsByTicketRepo = new Map<string, string>();
  (cfg.sites as RawSite[]).forEach((site, i) => {
    const at = `sites[${i}]`;
    if (typeof site !== 'object' || site === null) return void problems.push(`${at} is not an object`);
    for (const key of Object.keys(site)) if (!SITE_KEYS.has(key)) problems.push(`${at} has unknown key ${key}`);
    const repo = site?.repo;
    if (typeof repo !== 'string' || !isRepoKey(repo)) problems.push(`${at}.repo must be lowercase owner/name`);
    if (typeof repo === 'string' && repos.has(repo.toLowerCase())) problems.push(`${at}.repo is listed twice`);
    if (typeof repo === 'string') repos.add(repo.toLowerCase());
    const ticketRepo = site?.ticketRepo;
    if (typeof ticketRepo !== 'string' || !isRepoKey(ticketRepo)) {
      problems.push(`${at}.ticketRepo must be lowercase owner/name`);
    }
    // A site shows its tickets to its readers and drives their labels, so it
    // may only use tickets of its own owner.
    if (typeof ticketRepo === 'string' && typeof repo === 'string' && ownerOf(ticketRepo) !== ownerOf(repo)) {
      problems.push(`${at}.ticketRepo must belong to the same owner as repo`);
    }
    const aud = site?.accessAud;
    if (typeof aud !== 'string' || !/^\S{1,200}$/.test(aud)) problems.push(`${at}.accessAud is missing or malformed`);
    if (typeof aud === 'string' && auds.has(aud)) problems.push(`${at}.accessAud is shared with another site`);
    if (typeof aud === 'string') auds.add(aud);
    const domains = strings(site?.teamDomains);
    if (!domains || domains.length === 0) problems.push(`${at}.teamDomains must be a non-empty list`);
    if (domains && domains.some((d) => !DOMAIN.test(d))) problems.push(`${at}.teamDomains has a malformed domain`);
    if (domains && new Set(domains).size !== domains.length) problems.push(`${at}.teamDomains has a duplicate`);
    if (domains && domains.some((d) => PUBLIC_MAIL.has(d))) problems.push(`${at}.teamDomains has a public mail domain`);
    // Sites sharing a ticket repo share its tickets and labels, so they must
    // have the same team.
    if (domains && typeof ticketRepo === 'string') {
      const team = [...domains].sort().join(',');
      const seen = teamsByTicketRepo.get(ticketRepo);
      if (seen !== undefined && seen !== team) problems.push(`${at} shares ${ticketRepo} with a site of another team`);
      teamsByTicketRepo.set(ticketRepo, team);
    }
    const approvers = strings(site?.approvers);
    if (!approvers) problems.push(`${at}.approvers must be a list (it may be empty)`);
    for (const email of approvers ?? []) {
      const domain = EMAIL.exec(email)?.[1];
      if (!domain || email !== email.toLowerCase()) problems.push(`${at}.approvers has a malformed email`);
      else if (!domains?.includes(domain)) problems.push(`${at}.approvers has an email outside the team domains`);
    }
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
  const cfg = raw as { accessTeamDomain: string; sites: Site[] };
  const config: HubConfig = {
    accessTeamDomain: cfg.accessTeamDomain,
    sites: new Map(cfg.sites.map((s) => [s.repo, s])),
  };
  cached = { text: text ?? '', config };
  return config;
};
