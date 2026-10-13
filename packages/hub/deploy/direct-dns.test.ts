// #27: the deploy wait through a hostname's own nameservers. Case numbers are
// the ticket's revised plan.
import { execFileSync } from 'node:child_process';
import { createSocket, type Socket } from 'node:dgram';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authoritativeAddresses, type Answer, type Dns, MAX_CNAME_LINKS, probeAddress, systemDns } from './direct-dns';
import { viaNameservers } from './deploy';

const TEAM = 'acme.cloudflareaccess.com';
const HOST = 'specs.acme.test';

// A stand-in DNS: zones with nameservers, and what each name answers.
const fakeDns = (zones: Record<string, string[]>, answers: Record<string, Answer>) => {
  const queries: { servers: string[]; name: string }[] = [];
  const dns: Dns = {
    ns: async (zone) => (zones[zone] ? [`ns.${zone}`] : []),
    addressesOf: async (ns) => zones[ns.replace(/^ns\./, '')] ?? [],
    query: async (servers, name) => {
      queries.push({ servers, name });
      return answers[name] ?? { missing: true };
    },
  };
  return { dns, queries };
};
const toAccess = { status: 302, location: `https://${TEAM}/cdn-cgi/access/login/${HOST}` };

describe('27: authoritative lookup', () => {
  it('8: walks up to the enclosing zone and asks only its nameservers', async () => {
    const { dns, queries } = fakeDns(
      { 'acme.test': ['192.0.2.53'] },
      { [HOST]: { addresses: ['2001:db8::1', '192.0.2.1'] } },
    );
    expect(await authoritativeAddresses(HOST, dns)).toEqual(['2001:db8::1', '192.0.2.1']);
    expect(queries).toEqual([{ servers: ['192.0.2.53'], name: HOST }]);
  });

  it('6: a CNAME into another zone is resolved from that zone', async () => {
    const { dns, queries } = fakeDns(
      { 'acme.test': ['192.0.2.53'], 'edge.example': ['198.51.100.53'] },
      { [HOST]: { cname: 'hub.edge.example.' }, 'hub.edge.example': { addresses: ['198.51.100.7'] } },
    );
    expect(await authoritativeAddresses(HOST, dns)).toEqual(['198.51.100.7']);
    expect(queries.map((q) => [q.name, q.servers[0]])).toEqual([
      [HOST, '192.0.2.53'],
      ['hub.edge.example', '198.51.100.53'],
    ]);
  });

  it('7: a CNAME loop ends after the link limit', async () => {
    const { dns, queries } = fakeDns(
      { 'acme.test': ['192.0.2.53'] },
      { 'a.acme.test': { cname: 'b.acme.test' }, 'b.acme.test': { cname: 'a.acme.test' } },
    );
    await expect(authoritativeAddresses('a.acme.test', dns)).rejects.toThrow(/CNAME links/);
    expect(queries).toHaveLength(MAX_CNAME_LINKS + 1);
  });

  it('9: no zone found is an error, not an empty answer', async () => {
    const { dns } = fakeDns({}, {});
    await expect(authoritativeAddresses(HOST, dns)).rejects.toThrow(/no nameservers/);
  });

  it('10: NXDOMAIN on two polls, then an address: each poll asks again', async () => {
    const answers: Record<string, Answer> = {};
    const { dns } = fakeDns({ 'acme.test': ['192.0.2.53'] }, answers);
    const probe = async () => toAccess;
    expect(await viaNameservers(HOST, TEAM, { dns, probe })).toBe(false);
    expect(await viaNameservers(HOST, TEAM, { dns, probe })).toBe(false);
    answers[HOST] = { addresses: ['192.0.2.1'] };
    expect(await viaNameservers(HOST, TEAM, { dns, probe })).toBe(true);
  });

  it('9: nameservers that time out make the poll not ready', async () => {
    const { dns } = fakeDns({ 'acme.test': ['192.0.2.53'] }, {});
    dns.query = () => Promise.reject(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' }));
    expect(await viaNameservers(HOST, TEAM, { dns, probe: async () => toAccess })).toBe(false);
  });

  it('4, 11: every address is tried in order; only the Access redirect counts', async () => {
    const { dns } = fakeDns(
      { 'acme.test': ['192.0.2.53'] },
      { [HOST]: { addresses: ['2001:db8::1', '192.0.2.1', '192.0.2.2'] } },
    );
    const tried: string[] = [];
    const answers: Record<string, { status: number; location: string | null } | null> = {
      '2001:db8::1': null,
      '192.0.2.1': { status: 302, location: 'https://elsewhere.example/login' },
      '192.0.2.2': toAccess,
    };
    const probe = async (_h: string, a: string) => (tried.push(a), answers[a]);
    expect(await viaNameservers(HOST, TEAM, { dns, probe })).toBe(true);
    expect(tried).toEqual(['2001:db8::1', '192.0.2.1', '192.0.2.2']);
    answers['192.0.2.2'] = { status: 530, location: null };
    expect(await viaNameservers(HOST, TEAM, { dns, probe })).toBe(false);
  });
});

// A real TLS server on loopback with a certificate for HOST only.
describe('27: probing one address', () => {
  let dir: string;
  let cert: string;
  let server: Server;
  let port: number;
  const seen: { servername?: string; host?: string }[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'specreview-probe-'));
    const key = path.join(dir, 'key.pem');
    const crt = path.join(dir, 'cert.pem');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-keyout',
        key,
        '-out',
        crt,
        '-subj',
        `/CN=${HOST}`,
        '-addext',
        `subjectAltName=DNS:${HOST}`,
        '-days',
        '1',
      ],
      { stdio: 'ignore' },
    );
    cert = readFileSync(crt, 'utf8');
    server = createServer({ key: readFileSync(key), cert }, (req, res) => {
      seen.push({ servername: (req.socket as { servername?: string }).servername, host: req.headers.host });
      res.writeHead(302, { location: toAccess.location }).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  });

  it('3: connects to the given address with the hostname as TLS name and Host', async () => {
    seen.length = 0;
    const answer = await probeAddress({ port, ca: cert })(HOST, '127.0.0.1');
    expect(answer).toEqual(toAccess);
    expect(seen).toEqual([{ servername: HOST, host: `${HOST}:${port}` }]);
  });

  it('3: a certificate for another name is no answer', async () => {
    expect(await probeAddress({ port, ca: cert })('other.acme.test', '127.0.0.1')).toBeNull();
  });

  it('5: an address that refuses falls through to the next', async () => {
    const { dns } = fakeDns({ 'acme.test': ['192.0.2.53'] }, { [HOST]: { addresses: ['::1', '127.0.0.1'] } });
    seen.length = 0;
    expect(await viaNameservers(HOST, TEAM, { dns, probe: probeAddress({ port, ca: cert, timeoutMs: 2_000 }) })).toBe(
      true,
    );
    expect(seen).toHaveLength(1);
  });
});

// A minimal authoritative DNS server on loopback, so the real client's
// handling of real answers is tested: addresses, no such name, a name with no
// records of a type, a CNAME, and a server that never answers.
type Zone = Record<string, { a?: string[]; aaaa?: string[]; cname?: string; silent?: true }>;
const TYPE = { A: 1, CNAME: 5, AAAA: 28 } as const;

const encodeName = (name: string) =>
  Buffer.concat([
    ...name
      .split('.')
      .filter(Boolean)
      .map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])),
    Buffer.from([0]),
  ]);
const ipv6 = (a: string) => {
  const [head, tail = ''] = a.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  return Buffer.from(groups.flatMap((g) => [parseInt(g, 16) >> 8, parseInt(g, 16) & 255]));
};
const record = (type: number, rdata: Buffer) => {
  const head = Buffer.alloc(12);
  head.writeUInt16BE(0xc00c, 0);
  head.writeUInt16BE(type, 2);
  head.writeUInt16BE(1, 4);
  head.writeUInt32BE(60, 6);
  head.writeUInt16BE(rdata.length, 10);
  return Buffer.concat([head, rdata]);
};

const dnsServer = (zone: Zone) =>
  new Promise<{ socket: Socket; server: string }>((resolve) => {
    const socket = createSocket('udp4');
    socket.on('message', (msg, from) => {
      let i = 12;
      const labels: string[] = [];
      while (msg[i] !== 0) {
        labels.push(msg.subarray(i + 1, i + 1 + msg[i]).toString());
        i += msg[i] + 1;
      }
      const qtype = msg.readUInt16BE(i + 1);
      const question = msg.subarray(12, i + 5);
      const entry = zone[labels.join('.').toLowerCase()];
      if (entry?.silent) return;
      const answers: Buffer[] = [];
      if (entry?.cname) answers.push(record(TYPE.CNAME, encodeName(entry.cname)));
      else if (qtype === TYPE.A)
        for (const a of entry?.a ?? []) answers.push(record(TYPE.A, Buffer.from(a.split('.').map(Number))));
      else if (qtype === TYPE.AAAA) for (const a of entry?.aaaa ?? []) answers.push(record(TYPE.AAAA, ipv6(a)));
      const head = Buffer.alloc(12);
      head.writeUInt16BE(msg.readUInt16BE(0), 0);
      head.writeUInt16BE(0x8400 | (entry ? 0 : 3), 2); // response, authoritative; NXDOMAIN when unknown
      head.writeUInt16BE(1, 4);
      head.writeUInt16BE(answers.length, 6);
      socket.send(Buffer.concat([head, question, ...answers]), from.port, from.address);
    });
    socket.bind(0, '127.0.0.1', () => resolve({ socket, server: `127.0.0.1:${socket.address().port}` }));
  });

describe('27: the real DNS client against a nameserver', () => {
  let socket: Socket;
  let server: string;
  beforeAll(async () => {
    ({ socket, server } = await dnsServer({
      'specs.acme.test': { a: ['192.0.2.1'], aaaa: ['2001:db8::1'] },
      'v4only.acme.test': { a: ['192.0.2.2'] },
      'empty.acme.test': {},
      'alias.acme.test': { cname: 'hub.edge.example' },
      'slow.acme.test': { silent: true },
    }));
  });
  afterAll(() => socket.close());

  it('addresses, AAAA first', async () => {
    expect(await systemDns.query([server], 'specs.acme.test')).toEqual({ addresses: ['2001:db8::1', '192.0.2.1'] });
  });
  it('one family is enough', async () => {
    expect(await systemDns.query([server], 'v4only.acme.test')).toEqual({ addresses: ['192.0.2.2'] });
  });
  it('7, 10: no such name is missing, not an error', async () => {
    expect(await systemDns.query([server], 'nope.acme.test')).toEqual({ missing: true });
  });
  it('a name with no records is missing', async () => {
    expect(await systemDns.query([server], 'empty.acme.test')).toEqual({ missing: true });
  });
  it('6: a CNAME out of the zone is returned to be followed', async () => {
    expect(await systemDns.query([server], 'alias.acme.test')).toEqual({ cname: 'hub.edge.example' });
  });
  it('9: a server that never answers is an error, not "missing"', { timeout: 15_000 }, async () => {
    await expect(systemDns.query([server], 'slow.acme.test')).rejects.toThrow(/no answer/);
  });
});
