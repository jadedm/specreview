import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { HubConfig } from './config';
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
// this hub's application (its audience). A token for another hub, however
// valid, is refused; so is anything when the key set is unreachable. Which
// sites the person may read is decided afterwards, per site (roles.ts).
export const identify = async (request: Request, config: HubConfig): Promise<string> => {
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) throw unauthorized();
  const payload: JWTPayload | null = await jwtVerify(token, keySetFor(config.accessTeamDomain), {
    issuer: `https://${config.accessTeamDomain}`,
    audience: config.accessAud,
    algorithms: ['RS256'],
  }).then(
    (r) => r.payload,
    () => null,
  );
  const email = typeof payload?.email === 'string' ? payload.email.trim().toLowerCase() : '';
  // Exactly one @ with something on both sides.
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw unauthorized();
  return email;
};
