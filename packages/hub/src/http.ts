export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message = code,
  ) {
    super(message);
  }
}

// Every JSON response, refusals included: never cached, never framed, never
// sniffed into something active.
const BASE_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'",
};

export const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: BASE_HEADERS });

export const errorResponse = (err: unknown): Response => {
  if (err instanceof AppError) return json({ error: { code: err.code, message: err.message } }, err.status);
  console.error('unhandled', err instanceof Error ? err.message : String(err));
  return json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' } }, 500);
};

const MAX_BODY_BYTES = 20_000;

const tooLarge = () => new AppError(413, 'BODY_TOO_LARGE');

// Stops reading once the body passes the limit, rather than buffering
// whatever a client sends and measuring it afterwards.
const readLimited = async (request: Request): Promise<string> => {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) throw tooLarge();
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    size += next.value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(next.value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(all);
};

// State-changing requests come only from our own pages: JSON, from our origin.
// A form post from another site can send neither.
export const readJsonBody = async (request: Request): Promise<unknown> => {
  const type = request.headers.get('content-type') ?? '';
  if (!/^application\/json(\s*;|$)/i.test(type)) throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE');
  const origin = request.headers.get('origin');
  if (origin !== new URL(request.url).origin) throw new AppError(403, 'BAD_ORIGIN');
  const text = await readLimited(request);
  const parsed = await Promise.resolve()
    .then(() => JSON.parse(text) as unknown)
    .catch(() => {
      throw new AppError(400, 'INVALID_JSON');
    });
  return parsed;
};
