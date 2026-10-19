// Secrets the hub keeps in D1 are sealed with the hub key: SPECREVIEW_KEY, 32
// random bytes in base64, a Worker secret that deploy sets once (#56). AES-GCM
// with a fresh IV per seal; the purpose is bound in, so a value sealed for one
// use cannot be opened as another.

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

export class SealError extends Error {
  override name = 'SealError';
}

const keyOf = async (hubKey: string | undefined) => {
  const raw = (() => {
    try {
      return hubKey ? unb64(hubKey.trim()) : null;
    } catch {
      return null;
    }
  })();
  if (raw?.length !== 32) throw new SealError('the hub key (SPECREVIEW_KEY) is not set or is not 32 bytes');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
};

export const seal = async (hubKey: string | undefined, purpose: string, plain: string) => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(purpose) },
    await keyOf(hubKey),
    new TextEncoder().encode(plain),
  );
  return `v1.${b64(iv)}.${b64(new Uint8Array(sealed))}`;
};

export const open = async (hubKey: string | undefined, purpose: string, sealed: string) => {
  const key = await keyOf(hubKey);
  const [version, iv, data] = sealed.split('.');
  if (version !== 'v1' || !iv || !data) throw new SealError('not a sealed value');
  const plain = await crypto.subtle
    .decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: new TextEncoder().encode(purpose) }, key, unb64(data))
    .catch(() => {
      throw new SealError('the hub key does not open this value');
    });
  return new TextDecoder().decode(plain);
};
