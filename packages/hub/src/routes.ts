import type { HubConfig, Site } from './config';

// Every request is /<repo>/<rest> on the org's hub. The repo must be one of
// the configured sites, spelled exactly. After it:
//   _api/<route>                 the site's API
//   _history/<commit>/<path>.md  an old version (team only)
//   anything else                a page or asset of the published version
// The path is split, never decoded, so %2F, %5C and other escapes cannot
// become separators. URL parsing has already resolved . and .., so what is
// checked here is the normalized target.

export type Route =
  | { kind: 'api'; site: Site; path: string }
  | { kind: 'history'; site: Site; commit: string; path: string }
  | { kind: 'page'; site: Site; path: string; directory: boolean };

const COMMIT = /^[0-9a-f]{40}$/;
const SEGMENT = /^[A-Za-z0-9._~-]+$/;
const plain = (s: string) => SEGMENT.test(s) && s !== '.' && s !== '..';

export const routeOf = (pathname: string, config: HubConfig): Route | null => {
  const [lead, repo, ...rest] = pathname.split('/');
  if (lead !== '' || repo === undefined) return null;
  const site = config.sites.get(repo);
  // /<repo> without a slash is not the site; /<repo>/ is its index.
  if (!site || rest.length === 0) return null;
  const [area, ...tail] = rest;
  if (area === '_api')
    return tail.length > 0 && tail.every(plain) ? { kind: 'api', site, path: `/${tail.join('/')}` } : null;
  if (area === '_history') return historyRoute(site, tail);
  return pageRoute(site, rest);
};

const historyRoute = (site: Site, tail: string[]): Route | null => {
  const [commit, ...segments] = tail;
  if (!commit || !COMMIT.test(commit) || segments.length === 0 || !segments.every(plain)) return null;
  const path = segments.join('/');
  return path.endsWith('.md') ? { kind: 'history', site, commit, path } : null;
};

// One trailing empty segment means a directory (its index); an empty segment
// anywhere else is a doubled slash and not a page. _api and _history never
// get here (routeOf).
const pageRoute = (site: Site, segments: string[]): Route | null => {
  const directory = segments[segments.length - 1] === '';
  const parts = directory ? segments.slice(0, -1) : segments;
  if (!parts.every(plain)) return null;
  return { kind: 'page', site, path: parts.join('/'), directory };
};
