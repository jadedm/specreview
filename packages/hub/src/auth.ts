import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { HubConfig, Site } from './config';
import { AppError } from './http';

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

const keySetFor = (teamDomain: string) => {
  const existing = keySets.get(teamDomain);
  if (existing) return existing;
  const created = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`), {
    timeoutDuration: 3_000,
    cooldownDuration: 30_000,
  });
  keySets.set(teamDomain, created);
  return created;
};

const unauthorized = () => new AppError(401, 'UNAUTHORIZED', 'Sign in to use this.');

// The only identity trusted is the email inside a token Access signed for
// this site's own application (its audience). A token for another site,
// however valid, is refused; so is anything when the key set is unreachable.
export const identify = async (request: Request, config: HubConfig, site: Site): Promise<string> => {
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) throw unauthorized();
  const payload: JWTPayload | null = await jwtVerify(token, keySetFor(config.accessTeamDomain), {
    issuer: `https://${config.accessTeamDomain}`,
    audience: site.accessAud,
    algorithms: ['RS256'],
  }).then(
    (r) => r.payload,
    () => null,
  );
  const email = payload?.email;
  if (typeof email !== 'string' || !email.includes('@')) throw unauthorized();
  return email.trim().toLowerCase();
};
