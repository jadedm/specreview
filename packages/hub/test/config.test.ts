// Each config rule on its own: every case breaks exactly one rule and must
// report exactly that problem, so no rule is hidden behind another.
import { describe, expect, it, vi } from 'vitest';
import { problemsIn } from '../src/config';
import { CONFIG } from './helpers';

type C = typeof CONFIG;
const valid = () => structuredClone(CONFIG);
type Site = C['sites'][number] & Record<string, unknown>;
const site2 = (c: C) => c.sites[2] as Site;

describe('config rules, one at a time', () => {
  it('the test config is valid', () => {
    expect(problemsIn(valid())).toEqual([]);
  });

  it('#92 (1): no sites is a hub just installed, and valid', () => {
    expect(problemsIn({ ...valid(), sites: [] })).toEqual([]);
  });

  it('company domains that share a name with a mail brand are fine', () => {
    for (const domain of ['web.dev', 'hey.app', 'orange.com', 'mac.org']) {
      const c = valid();
      c.sites[2].teamDomains = [domain];
      c.sites[2].approvers = [];
      expect(problemsIn(c), domain).toEqual([]);
    }
  });

  it('labels in other scripts, with joiners, direction marks and emoji, are fine', () => {
    for (const label of [
      '\u062a\u06cc\u0645 \u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645',
      '\u0915\u094d\u200d\u0937 team',
      '\u{1f469}\u200d\u{1f4bb} team',
      '\u05e6\u05d5\u05d5\u05ea\u200f',
      'Équipe Acme',
      '\u30c1\u30fc\u30e0',
      '\u{1f600}'.repeat(40),
    ]) {
      expect(problemsIn({ ...valid(), teamLabel: label }), label).toEqual([]);
    }
  });

  it('team labels of 1 and 40 characters, at hub and site level, are fine', () => {
    expect(problemsIn({ ...valid(), teamLabel: 'I' })).toEqual([]);
    const c = valid();
    (c.sites[2] as Site).teamLabel = 'x'.repeat(40);
    expect(problemsIn(c)).toEqual([]);
  });

  it('a $schema line and a company subdomain as team domain are fine', () => {
    expect(problemsIn({ $schema: './specreview.schema.json', ...valid() })).toEqual([]);
    const c = valid();
    c.sites[2].teamDomains = ['mail.globex.dev'];
    c.sites[2].approvers = [];
    expect(problemsIn(c)).toEqual([]);
  });

  it('1: the #3 shape (owner in repo, audience per site) is refused', () => {
    const old = {
      accessTeamDomain: CONFIG.accessTeamDomain,
      sites: [
        {
          repo: 'acme/sidecar',
          accessAud: 'aud',
          teamDomains: ['acme.dev'],
          approvers: [],
          ticketRepo: 'acme/sidecar',
        },
      ],
    };
    expect(problemsIn(old).length).toBeGreaterThan(0);
  });

  const cases: [string, (c: C) => unknown, RegExp][] = [
    ['missing org', (c) => ({ ...c, org: undefined }), /org must be/],
    ['bad org', (c) => ({ ...c, org: 'Acme Tech' }), /org must be/],
    ['empty team domain', (c) => ({ ...c, accessTeamDomain: '' }), /accessTeamDomain/],
    ['team domain not Access', (c) => ({ ...c, accessTeamDomain: 'evil.example.com' }), /accessTeamDomain/],
    ['missing hub audience', (c) => ({ ...c, accessAud: '' }), /accessAud/],
    ['no admins', (c) => ({ ...c, admins: [] }), /admins must be/],
    ['malformed admin', (c) => ({ ...c, admins: ['Owner@acme.dev'] }), /admins has a malformed email/],
    ['admin with a malformed domain', (c) => ({ ...c, admins: ['owner@acme'] }), /admins has a malformed email/],
    ['duplicate admin', (c) => ({ ...c, admins: ['owner@acme.dev', 'owner@acme.dev'] }), /admins has a duplicate/],
    ['empty team label', (c) => ({ ...c, teamLabel: '' }), /^teamLabel must be 1 to 40/],
    ['long team label', (c) => ({ ...c, teamLabel: 'x'.repeat(41) }), /^teamLabel must be 1 to 40/],
    ['team label not a string', (c) => ({ ...c, teamLabel: 7 }), /^teamLabel must be 1 to 40/],
    ['team label with a newline', (c) => ({ ...c, teamLabel: 'Acme\nteam' }), /^teamLabel must have no control/],
    ['team label with a tab', (c) => ({ ...c, teamLabel: 'Acme\tteam' }), /^teamLabel must have no control/],
    ['padded team label', (c) => ({ ...c, teamLabel: ' Acme team' }), /^teamLabel must have no control/],
    ['team label that is an email', (c) => ({ ...c, teamLabel: 'team@acme.dev' }), /^teamLabel must not contain @/],
    [
      'team label with a bidi override',
      (c) => ({ ...c, teamLabel: 'Acme \u202eteam' }),
      /^teamLabel must have no control/,
    ],
    [
      'team label with a line separator',
      (c) => ({ ...c, teamLabel: 'Acme\u2028team' }),
      /^teamLabel must have no control/,
    ],
    ['team label with a C1 control', (c) => ({ ...c, teamLabel: 'Acme\u0085team' }), /^teamLabel must have no control/],
    [
      'team label with a fullwidth at sign',
      (c) => ({ ...c, teamLabel: 'team\uff20acme.dev' }),
      /^teamLabel must not contain @/,
    ],
    ['team label You', (c) => ({ ...c, teamLabel: 'You' }), /^teamLabel must not be You or Reader/],
    ['team label of a blank Braille cell', (c) => ({ ...c, teamLabel: '\u2800' }), /^teamLabel must show something/],
    ['team label of a variation selector', (c) => ({ ...c, teamLabel: '\ufe0f' }), /^teamLabel must show something/],
    ['fullwidth You', (c) => ({ ...c, teamLabel: '\uff39\uff4f\uff55' }), /^teamLabel must not be You or Reader/],
    ['team label of Hangul filler', (c) => ({ ...c, teamLabel: '\u3164' }), /^teamLabel must show something/],
    ['team label of marks only', (c) => ({ ...c, teamLabel: '\u0336'.repeat(3) }), /^teamLabel must show something/],
    ['team label with an isolate', (c) => ({ ...c, teamLabel: 'Acme \u2067team' }), /^teamLabel must have no control/],
    ['team label of 41 emoji', (c) => ({ ...c, teamLabel: '\u{1f600}'.repeat(41) }), /^teamLabel must be 1 to 40/],
    ['You with a zero-width space', (c) => ({ ...c, teamLabel: 'You\u200b' }), /^teamLabel must not be You or Reader/],
    ['You with a joiner inside', (c) => ({ ...c, teamLabel: 'Y\u200dou' }), /^teamLabel must not be You or Reader/],
    [
      'You with a trailing Hangul filler',
      (c) => ({ ...c, teamLabel: 'You\u3164' }),
      /^teamLabel must not be You or Reader/,
    ],
    [
      'Reader with a tag character',
      (c) => ({ ...c, teamLabel: 'Reader\u{e0001}' }),
      /^teamLabel must not be You or Reader/,
    ],
    [
      'team label with a private-use character',
      (c) => ({ ...c, teamLabel: 'Team \ue000' }),
      /^teamLabel must have no control/,
    ],
    [
      'team label with an unassigned character',
      (c) => ({ ...c, teamLabel: 'Team \u0378' }),
      /^teamLabel must have no control/,
    ],
    [
      'team label with a lone surrogate',
      (c) => ({ ...c, teamLabel: 'Team \ud800' }),
      /^teamLabel must have no control/,
    ],
    [
      'team label with an annotation mark',
      (c) => ({ ...c, teamLabel: 'Team \ufff9x' }),
      /^teamLabel must have no control/,
    ],
    ['team label reader', (c) => ({ ...c, teamLabel: 'reader' }), /^teamLabel must not be You or Reader/],
    ['site team label blank', (c) => ((site2(c).teamLabel = '   '), c), /sites\[2\]\.teamLabel must have no control/],
    ['missing ownerId', (c) => ({ ...c, ownerId: undefined }), /ownerId must be/],
    ['ownerId as a number', (c) => ({ ...c, ownerId: 1001 }), /ownerId must be/],
    ['repo starting with _', (c) => ((c.sites[2].repo = '_publish'), c), /sites\[2\]\.repo may not start with _/],
    [
      'missing branch',
      (c) => (((site2(c) as Record<string, unknown>).branch = undefined), c),
      /sites\[2\]\.branch must be/,
    ],
    ['branch with refs/heads', (c) => ((c.sites[2].branch = 'refs/heads/main'), c), /sites\[2\]\.branch must be/],
    ['branch with ..', (c) => ((c.sites[2].branch = 'a..b'), c), /sites\[2\]\.branch must be/],
    [
      'repositoryId as a number',
      (c) => (((site2(c) as Record<string, unknown>).repositoryId = 2003), c),
      /repositoryId must be/,
    ],
    ['repositoryId not digits', (c) => ((c.sites[2].repositoryId = 'R_abc'), c), /repositoryId must be/],
    ['workflow outside .github/workflows', (c) => ((c.sites[2].workflow = 'docs.yml'), c), /workflow must be/],
    ['workflow with ..', (c) => ((c.sites[2].workflow = '.github/workflows/../x.yml'), c), /workflow must be/],
    [
      'environment not a string',
      (c) => (((site2(c) as Record<string, unknown>).environment = 5), c),
      /environment must be/,
    ],
    ['unknown top-level key', (c) => ({ ...c, sitez: [] }), /unknown key sitez/],
    ['sites missing', (c) => ({ ...c, sites: undefined }), /sites must be a list/],
    ['sites not a list', (c) => ({ ...c, sites: {} }), /sites must be a list/],
    ['bad repo', (c) => ((c.sites[2].repo = 'Globex'), c), /sites\[2\]\.repo must be/],
    ['repo with an owner', (c) => ((c.sites[2].repo = 'acme/globex'), c), /sites\[2\]\.repo must be/],
    ['duplicate repo', (c) => ((c.sites[1].repo = c.sites[0].repo), c), /sites\[1\]\.repo is listed twice/],
    ['bad ticketRepo', (c) => ((c.sites[2].ticketRepo = 'Bad'), c), /sites\[2\]\.ticketRepo must be/],
    ['ticketRepo with an owner', (c) => ((c.sites[2].ticketRepo = 'other/tracker'), c), /ticketRepo must be/],
    [
      'empty team domains',
      (c) => ((c.sites[2].teamDomains = []), (c.sites[2].approvers = []), c),
      /teamDomains must be/,
    ],
    [
      'bad team domain',
      (c) => ((c.sites[2].teamDomains = ['globex']), (c.sites[2].approvers = []), c),
      /malformed domain/,
    ],
    [
      'duplicate team domain',
      (c) => ((c.sites[2].teamDomains = ['globex.dev', 'globex.dev']), c),
      /teamDomains has a duplicate/,
    ],
    [
      'public mail as team',
      (c) => ((c.sites[2].teamDomains = ['gmail.com']), (c.sites[2].approvers = []), c),
      /public mail domain/,
    ],
    [
      'public mail approver domain',
      (c) => ((c.sites[2].approvers = ['@gmail.com']), c),
      /approvers\[0\] is a public mail domain/,
    ],
    [
      'bad approver email',
      (c) => ((c.sites[2].approvers = ['not-an-email']), c),
      /approvers\[0\] is not an email or @domain/,
    ],
    ['uppercase approver', (c) => ((c.sites[2].approvers = ['PM@globex.dev']), c), /approvers\[0\] must be lowercase/],
    [
      'duplicate approver',
      (c) => ((c.sites[2].approvers = ['pm@globex.dev', 'pm@globex.dev']), c),
      /approvers has a duplicate/,
    ],
    [
      'shared ticket repo, different team',
      (c) => ((c.sites[1].teamDomains = ['acme.dev', 'partner.example']), c),
      /shares sidecar with a site of another team/,
    ],
    ['unknown site key', (c) => ((site2(c).readerz = []), c), /sites\[2\] has unknown key readerz/],
    ['readers not a list', (c) => (((site2(c) as Record<string, unknown>).readers = 'x'), c), /readers must be a list/],
    [
      'duplicate reader',
      (c) => ((c.sites[2].readers = ['@initech.example', '@initech.example']), c),
      /readers has a duplicate/,
    ],
    ['uppercase reader', (c) => ((c.sites[2].readers = ['Riya@initech.example']), c), /must be lowercase/],
    ['reader with spaces', (c) => ((c.sites[2].readers = [' riya@initech.example']), c), /must be lowercase/],
    ['malformed reader email', (c) => ((c.sites[2].readers = ['riya-at-initech']), c), /not an email or @domain/],
    [
      'reader email with a malformed domain',
      (c) => ((c.sites[2].readers = ['riya@initech']), c),
      /not an email or @domain/,
    ],
    ['reader email with a doubled dot', (c) => ((c.sites[2].readers = ['riya@initech..example']), c), /not an email/],
    ['malformed reader domain', (c) => ((c.sites[2].readers = ['@initech']), c), /malformed @domain/],
    ['public mail reader domain', (c) => ((c.sites[2].readers = ['@gmail.com']), c), /public mail domain/],
    [
      'mail relay reader domain',
      (c) => ((c.sites[2].readers = ['@privaterelay.appleid.com']), c),
      /public mail domain/,
    ],
    ['regional public mail reader domain', (c) => ((c.sites[2].readers = ['@yahoo.co.in']), c), /public mail domain/],
  ];
  for (const domain of [
    'naver.com',
    '126.com',
    'laposte.net',
    'comcast.net',
    'free.fr',
    'yahoo.co.in',
    'hotmail.co.uk',
    'outlook.in',
    'pm.me',
    'web.de',
    'mail.ru',
    'rediffmail.com',
  ]) {
    cases.push([
      `regional public mail team ${domain}`,
      (c) => ((c.sites[2].teamDomains = [domain]), (c.sites[2].approvers = []), c),
      /public mail domain/,
    ]);
  }

  for (const [name, patch, expected] of cases) {
    it(name, () => {
      const problems = problemsIn(patch(valid()));
      expect(problems, name).toHaveLength(1);
      expect(problems[0]).toMatch(expected);
    });
  }
});

describe('14 (#57): configRepo', () => {
  it('is optional, a bare lowercase repo name, and qualified with the org', async () => {
    expect(problemsIn({ ...CONFIG, configRepo: 'docs-hub' })).toEqual([]);
    for (const bad of ['acme/docs-hub', 'Docs-Hub', '', 7]) {
      expect(problemsIn({ ...CONFIG, configRepo: bad }).join('\n')).toMatch(
        /configRepo must be the bare lowercase name/,
      );
    }
    const { configOf } = await import('../src/config');
    expect(configOf(JSON.stringify({ ...CONFIG, configRepo: 'docs-hub' })).configRepo).toBe('acme/docs-hub');
    expect(configOf(JSON.stringify(CONFIG)).configRepo).toBeNull();
  });
});

describe('#75: the admin hostname', () => {
  const without = () => {
    const { adminHostname: _a, accessAdminAud: _d, ...rest } = valid();
    return rest;
  };
  it('is optional; it goes with its audience, and either needs the docs hostname', () => {
    expect(problemsIn(without())).toEqual([]);
    for (const [key, problem] of [
      ['hostname', 'hostname goes with adminHostname or protoHostname'],
      ['adminHostname', 'adminHostname and accessAdminAud go together'],
      ['accessAdminAud', 'adminHostname and accessAdminAud go together'],
    ] as const) {
      const c = valid() as Record<string, unknown>;
      delete c[key];
      expect(problemsIn(c), key).toEqual([problem]);
    }
  });
  it.each([
    [{ adminHostname: 'docs.example.com' }, "adminHostname must differ from the docs sites' hostname"],
    [{ adminHostname: 'Admin.Example.com' }, 'adminHostname must be a bare lowercase hostname'],
    [{ adminHostname: 'https://admin.example.com' }, 'adminHostname must be a bare lowercase hostname'],
    [{ hostname: 'docs.example.com/x' }, 'hostname must be a bare lowercase hostname'],
    [
      { accessAdminAud: 'aud-hub' },
      "accessAdminAud must be the admin hostname's own Access application, not the hub's",
    ],
    [{ accessAdminAud: 'has space' }, 'accessAdminAud is malformed'],
  ])('%o is refused', (patch, problem) => {
    expect(problemsIn({ ...valid(), ...patch })).toEqual([problem]);
  });
  it('configOf exposes it, or null without it', async () => {
    const { configOf } = await import('../src/config');
    expect(configOf(JSON.stringify(CONFIG)).admin).toEqual({
      hostname: 'admin.example.com',
      aud: 'aud-admin',
      docsHostname: 'docs.example.com',
    });
    expect(configOf(JSON.stringify(without())).admin).toBeNull();
  });
});

describe('#77: problems name positions, never a person', () => {
  const people = ['Riya@Initech.example', ' sam@initech.example', '@gmail.com', 'Ann@acme.dev', 'bo@elsewhere.example'];
  const broken = () => {
    const c = valid();
    c.sites[2].readers = ['ok@initech.example', people[0], people[1], people[2]];
    c.sites[0].approvers = [people[3], people[4]];
    return c;
  };

  it('a malformed reader is named by its place in the list', () => {
    const problems = problemsIn(broken());
    expect(problems).toContain('sites[2].readers[1] must be lowercase with no spaces');
    expect(problems.some((p) => p.startsWith('sites[2].readers[2] '))).toBe(true);
    expect(problems.some((p) => p.startsWith('sites[2].readers[3] '))).toBe(true);
  });

  it('no problem and no logged line holds an entry', async () => {
    const { configOf } = await import('../src/config');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => configOf(JSON.stringify(broken()))).toThrow();
    const logged = errors.mock.calls.flat().join(' ');
    errors.mockRestore();
    expect(logged).toContain('sites[2].readers[1]');
    for (const text of [...problemsIn(broken()), logged])
      for (const person of people) expect(text.toLowerCase(), person).not.toContain(person.trim().toLowerCase());
  });
});

describe('#91: team by email, approvers by email or @domain anywhere', () => {
  const withSite = (patch: Record<string, unknown>, i = 2) => {
    const c = valid() as unknown as { sites: Record<string, unknown>[] };
    c.sites[i] = { ...c.sites[i], ...patch };
    return c;
  };
  it('team takes lowercase unique emails of any domain, and is optional', () => {
    expect(problemsIn(withSite({ team: ['manish@ariai.example', 'x@gmail.com'] }))).toEqual([]);
    expect(problemsIn(withSite({ team: ['Manish@ariai.example'] }))).toEqual([
      'sites[2].team[0] must be a lowercase email',
    ]);
    expect(problemsIn(withSite({ team: ['@ariai.example'] }))).toEqual(['sites[2].team[0] must be a lowercase email']);
    expect(problemsIn(withSite({ team: ['a@b.example', 'a@b.example'] }))).toEqual(['sites[2].team has a duplicate']);
    expect(problemsIn(withSite({ team: 'a@b.example' }))).toEqual(['sites[2].team must be a list of emails']);
  });
  it('approvers outside the team domains, by email or @domain, are fine; a public mail domain is not', () => {
    expect(problemsIn(withSite({ approvers: ['boss@elsewhere.example', '@leads.example'] }))).toEqual([]);
    expect(problemsIn(withSite({ approvers: ['@gmail.com'] }))).toEqual([
      'sites[2].approvers[0] is a public mail domain',
    ]);
  });
  it('sites sharing a ticket repo may name different people in team and approvers', () => {
    const c = withSite({ team: ['manish@ariai.example'], approvers: ['boss@elsewhere.example'] }, 0);
    expect(problemsIn(c)).toEqual([]);
  });
});

// #135: people entries must be shaped like an email; what an address may hold
// before the @ is RFC 5322 atext and dots.
describe('#135: entries shaped like an email', () => {
  const withSite = (patch: Record<string, unknown>, i = 2) => {
    const c = valid() as unknown as { sites: Record<string, unknown>[] };
    c.sites[i] = { ...c.sites[i], ...patch };
    return c;
  };
  const bad = ['<b>x</b>@acme.dev', 'a b@acme.dev', '"q"@acme.dev', 'a,b@acme.dev', 'a@b@acme.dev'];
  // A bare @ is read as an @domain with no domain, and refused as one.
  const dots = ['.a@acme.dev', 'a.@acme.dev', 'a..b@acme.dev'];
  const good = [
    "o'brien@acme.dev",
    'first.last+tag@acme.dev',
    'a_b-c@acme.dev',
    'x!#$%&*/=?^{}~@acme.dev',
    '12345@acme.dev',
    // Letters of any script, as the rule before this one allowed.
    'josé@acme.dev',
    '用户@acme.dev',
  ];

  it('1, 2, 3: readers and approvers refuse what an address cannot hold, by position, and take real ones', () => {
    for (const list of ['readers', 'approvers']) {
      for (const entry of [...bad, ...dots]) {
        const problems = problemsIn(withSite({ [list]: [entry] }));
        expect(problems, `${list} ${entry}`).toEqual([`sites[2].${list}[0] is not an email or @domain`]);
        expect(problems.join(' '), entry).not.toContain(entry);
      }
      for (const entry of good) expect(problemsIn(withSite({ [list]: [entry] })), `${list} ${entry}`).toEqual([]);
    }
  });

  it('4: team and admins alike', () => {
    for (const entry of [...bad, ...dots]) {
      expect(problemsIn(withSite({ team: [entry] })), entry).toEqual(['sites[2].team[0] must be a lowercase email']);
      expect(problemsIn({ ...valid(), admins: [entry] }), entry).toEqual(['admins has a malformed email']);
    }
    for (const entry of good) {
      expect(problemsIn(withSite({ team: [entry] })), entry).toEqual([]);
      expect(problemsIn({ ...valid(), admins: [entry] }), entry).toEqual([]);
    }
  });

  it('lengths: 64 before the @ and 254 in all, no more', () => {
    // A domain of exactly n characters, in labels of at most 63, ending .dev.
    const domainOf = (n: number) => {
      const labels: string[] = [];
      let left = n - 4;
      while (left > 0) {
        const take = Math.min(63, left === 64 ? 62 : left);
        labels.push('d'.repeat(take));
        left -= take + 1;
      }
      return `${labels.join('.')}.dev`;
    };
    const ok = (e: string) => problemsIn(withSite({ readers: [e] })).length === 0;
    expect(domainOf(189)).toHaveLength(189);
    expect(ok(`${'a'.repeat(64)}@acme.dev`)).toBe(true);
    expect(ok(`${'a'.repeat(65)}@acme.dev`)).toBe(false);
    expect(ok(`${'a'.repeat(64)}@${domainOf(189)}`)).toBe(true);
    expect(ok(`${'a'.repeat(64)}@${domainOf(190)}`)).toBe(false);
  });

  it('5: @domain entries are unchanged', () => {
    expect(problemsIn(withSite({ readers: ['@partner.example'], approvers: ['@acme.dev'] }))).toEqual([]);
    expect(problemsIn(withSite({ readers: ['@'] }))).toEqual(['sites[2].readers[0] is a malformed @domain']);
  });
});
