import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { HubConfig, Site } from './config';
import { AppError } from './http';

// GitHub Actions' OIDC tokens: who is publishing, proven by GitHub, with no
// secret in the product repo.
export const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';
let keys: ReturnType<typeof createRemoteJWKSet> | null = null;
const keySet = () =>
  (keys ??= createRemoteJWKSet(new URL(`${GITHUB_ISSUER}/.well-known/jwks`), {
    timeoutDuration: 3_000,
    cooldownDuration: 30_000,
  }));

// For tests: the next verification fetches the keys again.
export const forgetGithubKeys = () => {
  keys = null;
};

export type PublishClaims = { sha: string; runId: string; runAttempt: string; jti: string };

// jose reports a failed or slow key fetch as these, or as a plain error from
// fetch; a bad token has a more specific code.
const keysUnavailable = (e: unknown) => {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code !== 'string' || code === 'ERR_JWKS_TIMEOUT' || code === 'ERR_JOSE_GENERIC';
};

const unauthorized = () => new AppError(401, 'UNAUTHORIZED', 'A GitHub Actions token is required.');
const forbidden = () => new AppError(403, 'FORBIDDEN', 'This token may not publish this site.');
const str = (v: unknown) => (typeof v === 'string' ? v : '');

// <owner>/<repo>/<path>@<ref>: owner and repo ignore case as GitHub does;
// the workflow path and ref are exact, so DOCS.yml is not docs.yml.
const workflowMatches = (workflowRef: string, repo: string, pathAndRef: string) =>
  workflowRef.endsWith(`/${pathAndRef}`) &&
  workflowRef.slice(0, workflowRef.length - pathAndRef.length - 1).toLowerCase() === repo;

// Names route, ids authorize: a renamed or transferred repository keeps its
// id, and a new repository under the old name gets a different one. The
// workflow, branch and event are pinned exactly: any other workflow in the
// repo, a pull request, pull_request_target, workflow_run, a dispatch or a
// schedule is refused, whatever ref it carries.
const allowed = (p: JWTPayload, config: HubConfig, site: Site) => {
  const repo = `${config.org}/${site.repo}`;
  const branchRef = `refs/heads/${site.branch}`;
  const checks = [
    str(p.repository_id) === site.repositoryId,
    str(p.repository_owner_id) === config.ownerId,
    str(p.repository).toLowerCase() === repo,
    workflowMatches(str(p.workflow_ref), repo, `${site.workflow}@${branchRef}`),
    str(p.ref) === branchRef,
    str(p.event_name) === 'push',
    site.environment === null || str(p.environment) === site.environment,
  ];
  return checks.every(Boolean);
};

export const verifyPublishToken = async (
  request: Request,
  config: HubConfig,
  site: Site,
  audience: string,
): Promise<PublishClaims> => {
  const auth = request.headers.get('authorization') ?? '';
  const token = /^Bearer ([A-Za-z0-9._-]+)$/.exec(auth)?.[1];
  if (!token) throw unauthorized();
  const result = await jwtVerify(token, keySet(), {
    issuer: GITHUB_ISSUER,
    audience,
    algorithms: ['RS256'],
  }).then(
    (r) => ({ payload: r.payload }),
    (e: unknown) => ({ error: e }),
  );
  // GitHub's keys could not be fetched: a retry can succeed, so not 401.
  if ('error' in result && keysUnavailable(result.error)) {
    throw new AppError(503, 'KEYS_UNAVAILABLE', "GitHub's signing keys could not be fetched; try again shortly.");
  }
  if (!('payload' in result)) throw unauthorized();
  const payload = result.payload;
  if (!allowed(payload, config, site)) throw forbidden();
  const claims = {
    sha: str(payload.sha),
    runId: str(payload.run_id),
    runAttempt: str(payload.run_attempt),
    jti: str(payload.jti),
  };
  const wellFormed =
    /^[0-9a-f]{40}$/.test(claims.sha) &&
    /^[0-9]{1,20}$/.test(claims.runId) &&
    /^[0-9]{1,6}$/.test(claims.runAttempt) &&
    /^[\x21-\x7e]{1,200}$/.test(claims.jti);
  if (!wellFormed) throw forbidden();
  return claims;
};
