// Asks a hostname's own nameservers for its addresses and probes each one,
// for when the machine's resolver still holds a "no such name" answer cached
// from before the deploy created the record (#27). Public resolvers cache
// that answer too, for up to the zone's SOA minimum, so they are no fix;
// authoritative nameservers hold no cache.
import { isIPv6 } from 'node:net';
import { Resolver } from 'node:dns/promises';
import { request } from 'node:https';

export type Answer = { addresses: string[] } | { cname: string } | { missing: true };

export type Dns = {
  // NS names of a zone through the system resolver; [] when it has none.
  ns(zone: string): Promise<string[]>;
  // Addresses of a nameserver through the system resolver.
  addressesOf(nameserver: string): Promise<string[]>;
  // The name's AAAA and A records, or its CNAME, asked of these servers only.
  query(servers: string[], name: string): Promise<Answer>;
};

const QUERY_TIMEOUT_MS = 2_000;
export const MAX_CNAME_LINKS = 8;

const codeOf = (err: unknown) => (err as { code?: string } | null)?.code;
const settle = <T>(p: Promise<T>, fallback: T) => p.catch(() => fallback);

export const systemDns: Dns = {
  ns: (zone) => settle(new Resolver({ timeout: QUERY_TIMEOUT_MS, tries: 1 }).resolveNs(zone), []),
  addressesOf: async (nameserver) => {
    const r = new Resolver({ timeout: QUERY_TIMEOUT_MS, tries: 1 });
    const [v4, v6] = await Promise.all([settle(r.resolve4(nameserver), []), settle(r.resolve6(nameserver), [])]);
    return [...v4, ...v6];
  },
  query: async (servers, name) => {
    const r = new Resolver({ timeout: QUERY_TIMEOUT_MS, tries: 1 });
    r.setServers(servers);
    // ENODATA is "the name exists, no records of this type"; ENOTFOUND is
    // "no such name"; anything else (a timeout, a refusal) is no answer.
    const records = (p: Promise<string[]>) => p.catch((err: unknown) => codeOf(err) ?? 'ERROR');
    const [v6, v4] = await Promise.all([records(r.resolve6(name)), records(r.resolve4(name))]);
    // One family answering is enough, even if the other timed out.
    const addresses = [...(Array.isArray(v6) ? v6 : []), ...(Array.isArray(v4) ? v4 : [])];
    if (addresses.length > 0) return { addresses };
    if (v4 === 'ENOTFOUND' && v6 === 'ENOTFOUND') return { missing: true };
    const answered = (c: unknown) => Array.isArray(c) || c === 'ENODATA' || c === 'ENOTFOUND';
    if (!answered(v4) || !answered(v6)) throw new Error(`no answer for ${name} (${String(v6)}, ${String(v4)})`);
    const cnames = await records(r.resolveCname(name));
    if (Array.isArray(cnames) && cnames[0]) return { cname: cnames[0] };
    if (answered(cnames)) return { missing: true };
    throw new Error(`no answer for the CNAME of ${name} (${String(cnames)})`);
  },
};

// The nameservers of the closest enclosing zone: the hostname itself, then
// each parent, stopping above the top-level domain.
const zoneServers = async (name: string, dns: Dns): Promise<string[]> => {
  const labels = name.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const nameservers = await dns.ns(labels.slice(i).join('.'));
    if (nameservers.length === 0) continue;
    const addresses = (await Promise.all(nameservers.map((n) => dns.addressesOf(n)))).flat();
    if (addresses.length > 0) return addresses;
  }
  throw new Error(`no nameservers found for ${name}`);
};

// AAAA first, then A. A CNAME is followed from its target's own zone, at most
// MAX_CNAME_LINKS links, so a loop ends.
export const authoritativeAddresses = async (hostname: string, dns: Dns = systemDns): Promise<string[]> => {
  let name = hostname;
  for (let link = 0; link <= MAX_CNAME_LINKS; link++) {
    const answer = await dns.query(await zoneServers(name, dns), name);
    if ('addresses' in answer) return answer.addresses;
    if ('missing' in answer) return [];
    name = answer.cname.replace(/\.$/, '');
  }
  throw new Error(`more than ${MAX_CNAME_LINKS} CNAME links from ${hostname}`);
};

export type Probe = (hostname: string, address: string) => Promise<{ status: number; location: string | null } | null>;

// GET https://<hostname>/ connected to one address: TLS name and Host are the
// hostname, so the certificate is checked for it as a normal request would.
// Redirects are not followed. null when there was no answer.
// It names one address, so Node is told not to try address families in
// turn (#100: that path threw "Cannot read properties of null (reading
// 'setServername')" inside request(), which rejected the probe, and the
// rejection ended the deploy); a throw from request() is no answer, and the
// callers treat a rejected probe the same way.
export const probeAddress =
  ({
    port = 443,
    ca,
    timeoutMs = 5_000,
    requestImpl = request,
  }: { port?: number; ca?: string; timeoutMs?: number; requestImpl?: typeof request } = {}): Probe =>
  (hostname, address) =>
    new Promise((resolve) => {
      const family = isIPv6(address) ? 6 : 4;
      let req: ReturnType<typeof request>;
      try {
        req = requestImpl(
          {
            host: hostname,
            servername: hostname,
            port,
            path: '/',
            method: 'GET',
            agent: false,
            ca,
            timeout: timeoutMs,
            family,
            // Passed through to the socket; Node's types leave it off RequestOptions.
            ...{ autoSelectFamily: false },
            // Node asks for every address when it may try several families.
            lookup: (_name, opts, callback) => {
              if ((opts as { all?: boolean }).all) {
                (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [
                  { address, family },
                ]);
                return;
              }
              callback(null, address, family);
            },
          },
          (res) => {
            res.resume();
            resolve({ status: res.statusCode ?? 0, location: res.headers.location ?? null });
          },
        );
      } catch {
        resolve(null);
        return;
      }
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', () => resolve(null));
      req.end();
    });
