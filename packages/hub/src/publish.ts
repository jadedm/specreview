// POST /_publish/<repo>: one request publishes one build. The whole build
// arrives at once and is checked whole, so a version is never partial and no
// two runs can interleave writes; the live pointer moves by compare-and-set,
// so two publishes cannot both win.
import { isManifest, MAX_MANIFEST_BYTES, type Manifest } from '@specreview/shared';
import type { HubConfig, Site } from './config';
import type { Env } from './env';
import { verifyPublishToken } from './github-oidc';
import { AppError, json } from './http';

// The body, its parts and the parsed form are all in memory at once; three
// copies must fit in a Worker's 128 MB.
export const MAX_BUNDLE_BYTES = 25 * 1024 * 1024;
export const MAX_FILES = 5_000;
const SEGMENT = /^[A-Za-z0-9._~-]+$/;
const COMMIT = /^[0-9a-f]{40}$/;
const POINTER_TRIES = 5;

const plainPath = (path: string) => path.split('/').every((p) => SEGMENT.test(p) && p !== '.' && p !== '..');
const invalid = (message: string) => new AppError(422, 'INVALID_BUNDLE', message);
const storage = (err: unknown) => {
  console.error('publish storage failed', err instanceof Error ? err.message : String(err));
  return new AppError(503, 'STORAGE_UNAVAILABLE', 'Storage is unavailable; try again shortly.');
};

// Reads at most `limit` bytes, counting what arrives rather than trusting
// Content-Length.
const readLimited = async (request: Request, limit: number): Promise<ArrayBuffer> => {
  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (let r = await reader.read(); !r.done; r = await reader.read()) {
    total += r.value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new AppError(413, 'TOO_LARGE', `A build may be at most ${limit} bytes.`);
    }
    chunks.push(r.value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out.buffer;
};

const sha256 = async (bytes: ArrayBuffer) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

type Bundle = { site: Map<string, ArrayBuffer>; history: Map<string, ArrayBuffer>; manifest: Manifest };

// site/<path> and history/<commit>/<path>.md parts, nothing else.
const readBundle = async (form: FormData): Promise<Bundle> => {
  const site = new Map<string, ArrayBuffer>();
  const history = new Map<string, ArrayBuffer>();
  let count = 0;
  for (const [name, value] of form.entries()) {
    if (typeof value === 'string') throw invalid(`${name}: every part must be a file`);
    if (++count > MAX_FILES) throw new AppError(413, 'TOO_MANY_FILES', `A build may have at most ${MAX_FILES} files.`);
    const bytes = await value.arrayBuffer();
    const sitePath = name.startsWith('site/') ? name.slice('site/'.length) : null;
    const historyPath = name.startsWith('history/') ? name.slice('history/'.length) : null;
    if (sitePath !== null && plainPath(sitePath)) {
      site.set(sitePath, bytes);
      continue;
    }
    const [commit, ...rest] = historyPath?.split('/') ?? [];
    const historyOk =
      historyPath !== null &&
      COMMIT.test(commit ?? '') &&
      rest.length > 0 &&
      plainPath(rest.join('/')) &&
      historyPath.endsWith('.md');
    if (!historyOk) throw invalid(`${name}: not a site or history path`);
    history.set(historyPath as string, bytes);
  }
  const manifestBytes = site.get('manifest.json');
  if (!manifestBytes) throw invalid('site/manifest.json is missing');
  if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) throw invalid('manifest.json is too large');
  const manifest = (() => {
    try {
      return JSON.parse(new TextDecoder().decode(manifestBytes)) as unknown;
    } catch {
      return undefined;
    }
  })();
  if (!isManifest(manifest)) throw invalid('manifest.json is not a valid manifest');
  return { site, history, manifest };
};

const htmlOf = (page: string) => `${page}.html`;

// One build, whole: the manifest names this commit, every page has its HTML,
// and the old versions are exactly the ones the manifest lists, each with
// the hash it records.
const checkBundle = async ({ site, history, manifest }: Bundle, sha: string) => {
  if (manifest.commit !== sha) throw invalid('manifest.json names another commit than this run');
  for (const page of Object.keys(manifest.pages)) {
    if (!site.has(htmlOf(page))) throw invalid(`${htmlOf(page)} is missing`);
  }
  const expected = new Map<string, string>();
  for (const entry of Object.values(manifest.pages).flatMap((p) => p.history)) {
    expected.set(`${entry.commit}/${entry.path}`, entry.hash);
  }
  for (const [path, hash] of expected) {
    const bytes = history.get(path);
    if (!bytes) throw invalid(`history/${path} is missing`);
    if ((await sha256(bytes)) !== hash) throw invalid(`history/${path} does not match its manifest hash`);
  }
  for (const path of history.keys()) {
    if (!expected.has(path)) throw invalid(`history/${path} is not in the manifest`);
  }
};

type Pointer = { version: string; runId: string; etag: string };

const readPointer = async (bucket: R2Bucket, repo: string): Promise<Pointer | null> => {
  const obj = await bucket.get(`${repo}/current.json`).catch((e: unknown) => {
    throw storage(e);
  });
  if (!obj) return null;
  const data = (await obj.json().catch(() => ({}))) as { version?: unknown; runId?: unknown };
  return {
    version: typeof data.version === 'string' ? data.version : '',
    runId: typeof data.runId === 'string' && /^[0-9]{1,20}$/.test(data.runId) ? data.runId : '0',
    etag: obj.etag,
  };
};

// The previous version's own assets (its assets list, one generation), so a
// tab opened on it keeps loading its hashed chunks after this publish.
const carryAssets = async (bucket: R2Bucket, repo: string, previous: string, version: string, own: Set<string>) => {
  const list = await bucket.get(`${repo}/meta/${previous}/assets.json`);
  if (!list) return;
  const paths = ((await list.json().catch(() => [])) as unknown[]).filter(
    (p): p is string => typeof p === 'string' && p.startsWith('assets/') && plainPath(p),
  );
  for (const path of paths.filter((p) => !own.has(p))) {
    const obj = await bucket.get(`${repo}/v/${previous}/${path}`);
    if (obj) await bucket.put(`${repo}/v/${version}/${path}`, obj.body);
  }
};

const randomHex = () =>
  [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join('');

export const publish = async (request: Request, env: Env, config: HubConfig, site: Site): Promise<Response> => {
  if (request.method !== 'POST') throw new AppError(405, 'METHOD_NOT_ALLOWED');
  const bucket = env.SITES;
  if (!bucket) throw new AppError(500, 'STORE_NOT_CONFIGURED');
  const claims = await verifyPublishToken(request, config, site, new URL(request.url).origin);
  const type = request.headers.get('content-type') ?? '';
  if (!type.startsWith('multipart/form-data')) throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE');

  // A token publishes once, recorded before anything else is written. Only a
  // duplicate means "used"; any other failure stops the publish, since going
  // on unrecorded would let the token be replayed.
  // A token lives minutes; rows older than a day can go.
  await env.DB.prepare('DELETE FROM publish_tokens WHERE used_at < ?')
    .bind(Date.now() - 24 * 60 * 60 * 1000)
    .run()
    .catch(() => undefined);
  const recorded = await env.DB.prepare('INSERT INTO publish_tokens (jti, site, used_at) VALUES (?, ?, ?)')
    .bind(claims.jti, site.key, Date.now())
    .run()
    .then(
      () => 'new' as const,
      (e: unknown) =>
        /UNIQUE constraint failed/i.test(e instanceof Error ? e.message : String(e)) ? 'used' : 'failed',
    );
  if (recorded === 'used') throw new AppError(409, 'TOKEN_USED', 'This token has already published.');
  if (recorded === 'failed') throw storage(new Error('could not record the publish token'));

  const body = await readLimited(request, MAX_BUNDLE_BYTES);
  const form = await new Response(body, { headers: { 'content-type': type } }).formData().catch(() => {
    throw invalid('the body is not a multipart form');
  });
  const bundle = await readBundle(form);
  await checkBundle(bundle, claims.sha);

  const version = `${claims.sha}-${claims.runId}-${claims.runAttempt}-${randomHex()}`;
  const repo = site.repo;
  const own = new Set([...bundle.site.keys()].filter((p) => p.startsWith('assets/')));
  try {
    for (const [path, bytes] of bundle.site) await bucket.put(`${repo}/v/${version}/${path}`, bytes);
    await bucket.put(`${repo}/meta/${version}/assets.json`, JSON.stringify([...own]));
  } catch (e) {
    throw storage(e);
  }

  for (let attempt = 0; attempt < POINTER_TRIES; attempt++) {
    const current = await readPointer(bucket, repo);
    // GitHub run ids grow; one too large for a JS number is compared as BigInt.
    if (current && BigInt(current.runId) > BigInt(claims.runId)) {
      throw new AppError(409, 'SUPERSEDED', 'A later run has already published; this version is not live.');
    }
    if (current?.version)
      await carryAssets(bucket, repo, current.version, version, own).catch((e: unknown) => {
        throw storage(e);
      });
    const pointer = JSON.stringify({ version, publishedAt: new Date().toISOString(), runId: claims.runId });
    const condition = current ? { etagMatches: current.etag } : new Headers({ 'if-none-match': '*' });
    const written = await bucket.put(`${repo}/current.json`, pointer, { onlyIf: condition }).catch((e: unknown) => {
      throw storage(e);
    });
    if (!written) continue;
    // History keys are shared across versions, so they are written only once
    // this version is live; the reader checks each against the live manifest.
    try {
      for (const [path, bytes] of bundle.history) await bucket.put(`${repo}/history/${path}`, bytes);
    } catch (e) {
      throw storage(e);
    }
    return json({ version });
  }
  throw new AppError(409, 'BUSY', 'Another publish kept changing the site; run again.');
};
