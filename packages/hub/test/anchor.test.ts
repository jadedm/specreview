// #38: a thread keeps its place when its heading is renamed, found again by
// its quote and the text either side. Case numbers are the ticket's plan.
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { forgetManifests } from '../src/manifest';
import { memoryStore } from '../src/store';
import { call, comment, deps, installFetch, manifests, PAGE, publishedFiles, reset, SIDECAR } from './helpers';

const READER = 'riya@initech.example';
const TEAM = 'manish@acme.dev';
const LIMITS = 'One account can own up to 3 companies, including ones waiting for approval.';
const QUOTE = 'including ones waiting for approval';
const CONTEXT = { prefix: 'can own up to 3 companies,', suffix: '' };

type Thread = {
  heading: string;
  outdated: boolean;
  quote: string;
  quoteHidden: boolean;
  movedFrom: string | null;
  prefix: string;
  suffix: string;
};
const threads = async (email = TEAM) =>
  (await call(`/api/comments?page=${encodeURIComponent(PAGE)}`, { email })).body as unknown as Thread[];
const stored = (id: unknown) =>
  env.DB.prepare('SELECT prefix, suffix FROM threads WHERE id = ?')
    .bind(id)
    .first<{ prefix: string; suffix: string }>();

// The live page republished with these sections in place of signup's.
const publishSections = (sections: { id: string; title: string; text: string }[]) => {
  const all = manifests();
  all[SIDECAR].pages[PAGE].sections = sections;
  deps.store = memoryStore(publishedFiles(all));
  forgetManifests();
};
const WHO = { id: 'who-can-sign-up', title: 'Who can sign up', text: 'Anyone with a work email can create a company.' };

let spy: ReturnType<typeof installFetch>;
beforeEach(async () => {
  spy = installFetch();
  await reset();
});
afterEach(() => spy.mockRestore());

describe('38: context on a new thread', () => {
  it('1: context that surrounds the quote is kept', async () => {
    const r = await comment(READER, { quote: QUOTE, ...CONTEXT, suffix: '' });
    expect(r.status).toBe(201);
    expect(await stored(r.body.id)).toEqual({ prefix: CONTEXT.prefix, suffix: '' });
  });

  it('1b: context that surrounds no occurrence of the quote is not kept; the comment still posts', async () => {
    const r = await comment(READER, { quote: QUOTE, prefix: 'not what comes before', suffix: '' });
    expect(r.status).toBe(201);
    expect(await stored(r.body.id)).toEqual({ prefix: '', suffix: '' });
  });
});

describe('38: context and readers', () => {
  it('a reader gets the context only while it still surrounds the quote; the team always', async () => {
    await comment(READER, { quote: QUOTE, ...CONTEXT });
    publishSections([
      WHO,
      { id: 'limits', title: 'Limits', text: 'Accounts are capped, including ones waiting for approval.' },
    ]);
    expect((await threads(READER))[0]).toMatchObject({ outdated: false, prefix: '', suffix: '' });
    expect((await threads(TEAM))[0]).toMatchObject({ prefix: CONTEXT.prefix });
  });
});

describe('38: a renamed heading', () => {
  it('4, 9: the thread is listed under the renamed section; the team sees where it was posted', async () => {
    await comment(READER, { quote: QUOTE, ...CONTEXT });
    publishSections([WHO, { id: 'account-limits', title: 'Account limits', text: LIMITS }]);
    const [team] = await threads(TEAM);
    expect(team).toMatchObject({ heading: 'account-limits', outdated: false, quote: QUOTE, movedFrom: 'limits' });
    const [reader] = await threads(READER);
    expect(reader).toMatchObject({ heading: 'account-limits', outdated: false, quote: QUOTE, quoteHidden: false });
    expect(reader.movedFrom).toBeNull();
  });

  it('5: the quote with the same context in two places stays outdated', async () => {
    await comment(READER, { quote: QUOTE, ...CONTEXT });
    publishSections([
      { id: 'account-limits', title: 'Account limits', text: LIMITS },
      { id: 'again', title: 'Again', text: LIMITS },
    ]);
    expect((await threads())[0]).toMatchObject({ heading: 'limits', outdated: true });
  });

  it('6: the quote gone stays outdated and hidden from readers', async () => {
    await comment(READER, { quote: QUOTE, ...CONTEXT });
    publishSections([WHO, { id: 'account-limits', title: 'Account limits', text: 'One account owns one company.' }]);
    expect((await threads(TEAM))[0]).toMatchObject({ outdated: true, movedFrom: null });
    expect((await threads(READER))[0]).toMatchObject({ outdated: true, quote: '', quoteHidden: true, heading: '' });
  });

  it('7: a thread without context is never placed on its quote alone', async () => {
    await comment(READER, { quote: QUOTE });
    publishSections([WHO, { id: 'account-limits', title: 'Account limits', text: LIMITS }]);
    expect((await threads())[0]).toMatchObject({ heading: 'limits', outdated: true });
  });

  it('8: a section that is still there keeps the rule: the quote moved out of it is outdated', async () => {
    await comment(READER, { quote: QUOTE, ...CONTEXT });
    publishSections([
      { id: 'limits', title: 'Limits', text: 'One account can own up to 3 companies.' },
      { id: 'pending', title: 'Pending', text: LIMITS },
    ]);
    expect((await threads())[0]).toMatchObject({ heading: 'limits', outdated: true });
  });
});
