import type { HubConfig, Site } from './config';
import type { Env } from './env';
import type { GitHubAuth } from './github-auth';
import { snapshotOf, type Snapshot } from './manifest';
import type { SiteStore } from './store';

export type Deps = { store: SiteStore; github: GitHubAuth };

// Everything a request handler needs: the environment, the pluggable store
// and GitHub access, the hub config, the one site the request is for, and
// that site's published snapshot, read once for the whole request.
export type Ctx = { env: Env; deps: Deps; config: HubConfig; site: Site; snapshot: () => Promise<Snapshot> };

export const makeCtx = (env: Env, deps: Deps, config: HubConfig, site: Site): Ctx => {
  let once: Promise<Snapshot> | null = null;
  return { env, deps, config, site, snapshot: () => (once ??= snapshotOf(deps.store, site.repo)) };
};

// The database key every query filters on: <org>/<repo>.
export const siteKey = (ctx: Ctx) => ctx.site.key;
