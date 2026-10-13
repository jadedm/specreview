import type { Env } from './env';
import { appAuth } from './github-app';

// Who the hub is to GitHub, per ticket repo: the GitHub App when its two
// secrets are set (#6), else the personal tokens. Callers ask for a token and
// treat none as "unavailable", never as an error to throw; they invalidate a
// token GitHub rejected so the next ask mints a new one.
export type Purpose = 'read' | 'write';
export type GitHubAuth = {
  tokenFor(repo: string, purpose: Purpose): Promise<string | null>;
  invalidate?(repo: string, purpose: Purpose): void;
};

export const envTokens = (env: Env): GitHubAuth => ({
  tokenFor: async (_repo, purpose) => (purpose === 'read' ? env.GITHUB_READ_TOKEN : env.GITHUB_WRITE_TOKEN) ?? null,
});

const noTokens: GitHubAuth = { tokenFor: async () => null };

// Deps are built per request; the app's caches have to outlive that.
let app: { id: string; key: string; auth: GitHubAuth } | null = null;
let warned = false;

const halfApp = (missing: string) => {
  if (!warned) console.error(`github app: ${missing} is not set`);
  warned = true;
  return noTokens;
};

export const githubAuthFor = (env: Env): GitHubAuth => {
  const id = env.GITHUB_APP_ID?.trim();
  const key = env.GITHUB_APP_PRIVATE_KEY;
  if (!id && !key) return envTokens(env);
  // Half an app is a mistake, not a reason to act as a person.
  if (!id || !key) return halfApp(id ? 'GITHUB_APP_PRIVATE_KEY' : 'GITHUB_APP_ID');
  if (app?.id !== id || app.key !== key) app = { id, key, auth: appAuth({ appId: id, privateKey: key }) };
  return app.auth;
};

export const forgetGitHubAppForTests = () => {
  app = null;
  warned = false;
};
