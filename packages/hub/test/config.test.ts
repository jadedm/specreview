// Each config rule on its own: every case breaks exactly one rule and must
// report exactly that problem, so no rule is hidden behind another.
import { describe, expect, it } from 'vitest';
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

  it('company domains that share a name with a mail brand are fine', () => {
    for (const domain of ['web.dev', 'hey.app', 'orange.com', 'mac.org']) {
      const c = valid();
      c.sites[2].teamDomains = [domain];
      c.sites[2].approvers = [];
      expect(problemsIn(c), domain).toEqual([]);
    }
  });

  it('a $schema line and a company subdomain as team domain are fine', () => {
    expect(problemsIn({ $schema: './specreview.schema.json', ...valid() })).toEqual([]);
    const c = valid();
    c.sites[2].teamDomains = ['mail.tikiti.live'];
    c.sites[2].approvers = [];
    expect(problemsIn(c)).toEqual([]);
  });

  it('1: the #3 shape (owner in repo, audience per site) is refused', () => {
    const old = {
      accessTeamDomain: CONFIG.accessTeamDomain,
      sites: [
        {
          repo: 'inoltrotech/sidecar',
          accessAud: 'aud',
          teamDomains: ['inoltro.ai'],
          approvers: [],
          ticketRepo: 'inoltrotech/sidecar',
        },
      ],
    };
    expect(problemsIn(old).length).toBeGreaterThan(0);
  });

  const cases: [string, (c: C) => unknown, RegExp][] = [
    ['missing org', (c) => ({ ...c, org: undefined }), /org must be/],
    ['bad org', (c) => ({ ...c, org: 'Inoltro Tech' }), /org must be/],
    ['empty team domain', (c) => ({ ...c, accessTeamDomain: '' }), /accessTeamDomain/],
    ['team domain not Access', (c) => ({ ...c, accessTeamDomain: 'evil.example.com' }), /accessTeamDomain/],
    ['missing hub audience', (c) => ({ ...c, accessAud: '' }), /accessAud/],
    ['no admins', (c) => ({ ...c, admins: [] }), /admins must be/],
    ['malformed admin', (c) => ({ ...c, admins: ['Owner@inoltro.ai'] }), /admins has a malformed email/],
    ['admin with a malformed domain', (c) => ({ ...c, admins: ['owner@inoltro'] }), /admins has a malformed email/],
    ['duplicate admin', (c) => ({ ...c, admins: ['owner@inoltro.ai', 'owner@inoltro.ai'] }), /admins has a duplicate/],
    ['unknown top-level key', (c) => ({ ...c, sitez: [] }), /unknown key sitez/],
    ['no sites', (c) => ({ ...c, sites: [] }), /sites must be a non-empty list/],
    ['bad repo', (c) => ((c.sites[2].repo = 'Tikiti'), c), /sites\[2\]\.repo must be/],
    ['repo with an owner', (c) => ((c.sites[2].repo = 'inoltrotech/tikiti'), c), /sites\[2\]\.repo must be/],
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
      (c) => ((c.sites[2].teamDomains = ['tikiti']), (c.sites[2].approvers = []), c),
      /malformed domain/,
    ],
    [
      'duplicate team domain',
      (c) => ((c.sites[2].teamDomains = ['tikiti.live', 'tikiti.live']), c),
      /teamDomains has a duplicate/,
    ],
    [
      'public mail as team',
      (c) => ((c.sites[2].teamDomains = ['gmail.com']), (c.sites[2].approvers = []), c),
      /public mail domain/,
    ],
    ['approver outside team', (c) => ((c.sites[2].approvers = ['pm@ariai.example']), c), /outside the team domains/],
    ['bad approver email', (c) => ((c.sites[2].approvers = ['not-an-email']), c), /malformed email/],
    ['uppercase approver', (c) => ((c.sites[2].approvers = ['PM@tikiti.live']), c), /malformed email/],
    [
      'duplicate approver',
      (c) => ((c.sites[2].approvers = ['pm@tikiti.live', 'pm@tikiti.live']), c),
      /approvers has a duplicate/,
    ],
    [
      'shared ticket repo, different team',
      (c) => ((c.sites[1].teamDomains = ['inoltro.ai', 'partner.example']), c),
      /shares sidecar with a site of another team/,
    ],
    ['unknown site key', (c) => ((site2(c).readerz = []), c), /sites\[2\] has unknown key readerz/],
    ['readers not a list', (c) => (((site2(c) as Record<string, unknown>).readers = 'x'), c), /readers must be a list/],
    [
      'duplicate reader',
      (c) => ((c.sites[2].readers = ['@ariai.example', '@ariai.example']), c),
      /readers has a duplicate/,
    ],
    ['uppercase reader', (c) => ((c.sites[2].readers = ['Riya@ariai.example']), c), /must be lowercase/],
    ['reader with spaces', (c) => ((c.sites[2].readers = [' riya@ariai.example']), c), /must be lowercase/],
    ['malformed reader email', (c) => ((c.sites[2].readers = ['riya-at-ariai']), c), /not an email or @domain/],
    [
      'reader email with a malformed domain',
      (c) => ((c.sites[2].readers = ['riya@ariai']), c),
      /not an email or @domain/,
    ],
    ['reader email with a doubled dot', (c) => ((c.sites[2].readers = ['riya@ariai..example']), c), /not an email/],
    ['malformed reader domain', (c) => ((c.sites[2].readers = ['@ariai']), c), /malformed @domain/],
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
