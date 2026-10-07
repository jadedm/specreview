import type { Env } from './env';

// Who the hub is to GitHub, per ticket repo. #6 replaces this with a GitHub
// App's installation tokens; callers ask for a token and treat none as
// "unavailable", never as an error to throw.
export type Purpose = 'read' | 'write';
export type GitHubAuth = { tokenFor(repo: string, purpose: Purpose): Promise<string | null> };

export const envTokens = (env: Env): GitHubAuth => ({
  tokenFor: async (_repo, purpose) => (purpose === 'read' ? env.GITHUB_READ_TOKEN : env.GITHUB_WRITE_TOKEN) ?? null,
});
