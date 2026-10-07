import type { HubConfig, Site } from './config';

// Every request is /<owner>/<repo>/<rest>. The site must be configured,
// spelled exactly (lowercase). After it:
//   _api/<route>                 the site's API
//   _history/<commit>/<path>.md  an old version (team only)
//   anything else                a page (served from the store in #4)
// The path is split, never decoded, so %2F, %5C and other escapes cannot
// become separators. URL parsing has already resolved dot segments, so a
// "../" can only move within what the URL itself means.

export type Route =
  | { kind: 'api'; site: Site; path: string }
  | { kind: 'history'; site: Site; commit: string; path: string }
  | { kind: 'page'; site: Site; path: string };

const COMMIT = /^[0-9a-f]{40}$/;
const SEGMENT = /^[A-Za-z0-9._-]+$/;
const plainSegment = (s: string) => SEGMENT.test(s) && s !== '.' && s !== '..';

export const routeOf = (pathname: string, config: HubConfig): Route | null => {
  const [lead, owner, repo, ...rest] = pathname.split('/');
  if (lead !== '' || owner === undefined || repo === undefined) return null;
  const site = config.sites.get(`${owner}/${repo}`);
  if (!site) return null;
  const [area, ...tail] = rest;
  if (area === '_api') return tail.length > 0 ? { kind: 'api', site, path: `/${tail.join('/')}` } : null;
  if (area === '_history') return historyRoute(site, tail);
  return { kind: 'page', site, path: rest.join('/') };
};

const historyRoute = (site: Site, tail: string[]): Route | null => {
  const [commit, ...segments] = tail;
  if (!commit || !COMMIT.test(commit) || segments.length === 0) return null;
  if (!segments.every(plainSegment)) return null;
  const path = segments.join('/');
  return path.endsWith('.md') ? { kind: 'history', site, commit, path } : null;
};
