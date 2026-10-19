import type { Env } from './env';
import { appAuth } from './github-app';
import { findApp } from './stored-app';

// Who the hub is to GitHub, per ticket repo, first match wins: the GitHub App
// in the GITHUB_APP_* secrets (#6), the app created from the admin page and
// stored in D1 (#56), the personal tokens. Callers ask for a token and treat
// none as "unavailable", never as an error to throw; they invalidate a token
// GitHub rejected so the next ask mints a new one.
// read and write are tickets and labels; the setup purposes add a site (#57),
// on the product repo and on the repo holding the config.
export type Purpose = 'read' | 'write' | 'setup-product' | 'setup-config' | 'browse';
export type GitHubAuth = {
  tokenFor(repo: string, purpose: Purpose): Promise<string | null>;
  invalidate?(repo: string, purpose: Purpose): void;
  installed?(repo: string): Promise<boolean | null>;
  // Whether this is a GitHub App (only an app can add a site, #57).
  hasApp?(): Promise<boolean>;
  // The org's repos the app's installation reaches (#63): names, sorted, no
  // archived ones; 'too-many' past the listing limit; null when GitHub cannot
  // say.
  repos?(owner: string): Promise<string[] | 'too-many' | null>;
};

// Personal tokens serve tickets and labels only; adding a site needs the app.
const PERSONAL: Record<Purpose, (env: Env) => string | undefined> = {
  read: (env) => env.GITHUB_READ_TOKEN,
  write: (env) => env.GITHUB_WRITE_TOKEN,
  'setup-product': () => undefined,
  'setup-config': () => undefined,
  browse: () => undefined,
};

export const envTokens = (env: Env): GitHubAuth => ({
  tokenFor: async (_repo, purpose) => PERSONAL[purpose](env) ?? null,
});

const noTokens: GitHubAuth = { tokenFor: async () => null };

// Deps are built per request; the app's caches have to outlive that.
let app: { id: string; key: string; auth: GitHubAuth } | null = null;
let warned = false;

const appFor = (id: string, key: string) => {
  if (app?.id !== id || app.key !== key) app = { id, key, auth: appAuth({ appId: id, privateKey: key }) };
  return app.auth;
};

// The stored app is read at most once a minute per isolate, so an app created
// or forgotten on the admin page takes effect everywhere within a minute. The
// app's own token caches (appFor) outlive these reads.
const RECHECK_MS = 60_000;
let stored: { auth: Promise<GitHubAuth>; until: number } | null = null;
let lockedLogged = false;

const resolveStored = async (env: Env): Promise<GitHubAuth> => {
  const found = await findApp(env);
  if (found.kind === 'app') return appFor(String(found.app.appId), found.app.privateKey);
  // Fail closed: an app the hub cannot open is not a reason to act as a person.
  if (found.kind === 'locked') {
    if (!lockedLogged) console.error(`github app: the stored app ${found.app.slug} cannot be opened: ${found.why}`);
    lockedLogged = true;
    return noTokens;
  }
  return envTokens(env);
};

const storedOrTokens = (env: Env): GitHubAuth => {
  const current = () => {
    if (stored && stored.until > Date.now()) return stored.auth;
    const auth = resolveStored(env).catch((err: unknown) => {
      // The database did not answer: no token now, ask again next time.
      stored = null;
      console.error('github app: the stored app could not be read', err instanceof Error ? err.message : String(err));
      return noTokens;
    });
    stored = { auth, until: Date.now() + RECHECK_MS };
    return auth;
  };
  return {
    tokenFor: async (repo, purpose) => (await current()).tokenFor(repo, purpose),
    invalidate: (repo, purpose) => {
      void current().then((a) => a.invalidate?.(repo, purpose));
    },
    installed: async (repo) => (await current()).installed?.(repo) ?? null,
    hasApp: async () => (await current()).hasApp?.() ?? false,
    repos: async (owner) => (await current()).repos?.(owner) ?? null,
  };
};

// After the admin page stores or forgets an app.
export const forgetStoredAuth = () => {
  stored = null;
  lockedLogged = false;
};

const halfApp = (missing: string) => {
  if (!warned) console.error(`github app: ${missing} is not set`);
  warned = true;
  return noTokens;
};

export const githubAuthFor = (env: Env): GitHubAuth => {
  const id = env.GITHUB_APP_ID?.trim();
  const key = env.GITHUB_APP_PRIVATE_KEY;
  if (!id && !key) return storedOrTokens(env);
  // Half an app is a mistake, not a reason to act as a person.
  if (!id || !key) return halfApp(id ? 'GITHUB_APP_PRIVATE_KEY' : 'GITHUB_APP_ID');
  return appFor(id, key);
};

export const forgetGitHubAppForTests = () => {
  app = null;
  warned = false;
  forgetStoredAuth();
};
