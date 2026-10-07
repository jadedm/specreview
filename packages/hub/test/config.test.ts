// Each config rule on its own: every case breaks exactly one rule and must
// report exactly that problem, so no rule is hidden behind another.
import { describe, expect, it } from 'vitest';
import { problemsIn } from '../src/config';
import { CONFIG } from './helpers';

type C = typeof CONFIG;
const valid = () => structuredClone(CONFIG);
const one = (patch: (c: C) => unknown) => problemsIn(patch(valid()));

describe('M7, M23: config rules, one at a time', () => {
  it('the test config is valid', () => {
    expect(problemsIn(valid())).toEqual([]);
  });

  it('a $schema line and a company subdomain as team domain are fine', () => {
    expect(problemsIn({ $schema: './specreview.schema.json', ...valid() })).toEqual([]);
    const c = valid();
    c.sites[2].teamDomains = ['mail.globex.dev'];
    c.sites[2].approvers = [];
    expect(problemsIn(c)).toEqual([]);
  });

  const cases: [string, (c: C) => unknown, RegExp][] = [
    ['empty team domain', (c) => ({ ...c, accessTeamDomain: '' }), /accessTeamDomain/],
    ['team domain not Access', (c) => ({ ...c, accessTeamDomain: 'evil.example.com' }), /accessTeamDomain/],
    ['unknown top-level key', (c) => ({ ...c, sitez: [] }), /unknown key sitez/],
    ['bad repo', (c) => ((c.sites[2].repo = 'globex/Backend'), c), /sites\[2\]\.repo must be lowercase/],
    ['repo with three parts', (c) => ((c.sites[2].repo = 'globex/a/b'), c), /sites\[2\]\.repo must be lowercase/],
    ['duplicate repo', (c) => ((c.sites[1].repo = c.sites[0].repo), c), /sites\[1\]\.repo is listed twice/],
    ['bad ticketRepo', (c) => ((c.sites[2].ticketRepo = 'globex/Bad'), c), /sites\[2\]\.ticketRepo must be lowercase/],
    [
      'ticketRepo of another owner',
      (c) => ((c.sites[2].ticketRepo = 'someone-else/tracker'), c),
      /sites\[2\]\.ticketRepo must belong to the same owner/,
    ],
    ['empty audience', (c) => ((c.sites[2].accessAud = ''), c), /sites\[2\]\.accessAud is missing/],
    [
      'duplicate audience',
      (c) => ((c.sites[2].accessAud = c.sites[0].accessAud), c),
      /sites\[2\]\.accessAud is shared/,
    ],
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
    ['approver outside team', (c) => ((c.sites[2].approvers = ['pm@initech.example']), c), /outside the team domains/],
    ['bad approver email', (c) => ((c.sites[2].approvers = ['not-an-email']), c), /malformed email/],
    ['uppercase approver', (c) => ((c.sites[2].approvers = ['PM@globex.dev']), c), /malformed email/],
    [
      'shared ticket repo, different team',
      (c) => ((c.sites[1].teamDomains = ['acme.dev', 'partner.example']), c),
      /shares acme\/sidecar with a site of another team/,
    ],
    [
      'unknown site key',
      (c) => (((c.sites[2] as Record<string, unknown>).readerz = []), c),
      /sites\[2\] has unknown key readerz/,
    ],
    ['no sites', (c) => ({ ...c, sites: [] }), /sites must be a non-empty list/],
  ];
  for (const domain of ['yahoo.co.in', 'hotmail.co.uk', 'outlook.in', 'pm.me', 'web.de', 'mail.ru', 'rediffmail.com']) {
    cases.push([
      `regional public mail ${domain}`,
      (c) => ((c.sites[2].teamDomains = [domain]), (c.sites[2].approvers = []), c),
      /public mail domain/,
    ]);
  }

  for (const [name, patch, expected] of cases) {
    it(name, () => {
      const problems = one(patch);
      expect(problems, name).toHaveLength(1);
      expect(problems[0]).toMatch(expected);
    });
  }
});
