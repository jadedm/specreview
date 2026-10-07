import type { HubConfig, Site } from './config';
import type { Env } from './env';
import type { GitHubAuth } from './github-auth';
import type { SiteStore } from './store';

export type Deps = { store: SiteStore; github: GitHubAuth };

// Everything a request handler needs: the environment, the pluggable store
// and GitHub access, the hub config, and the one site the request is for.
export type Ctx = { env: Env; deps: Deps; config: HubConfig; site: Site };

// The site key every query filters on.
export const siteKey = (ctx: Ctx) => ctx.site.repo;
