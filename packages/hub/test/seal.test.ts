import { describe, expect, it } from 'vitest';
import { open, seal } from '../src/seal';

// What the hub keeps in D1 is sealed with the hub key (#56).
const key = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

describe('seal', () => {
  it('opens with the same key and purpose; each seal is different', async () => {
    const k = key();
    const a = await seal(k, 'p', 'secret text');
    expect(await open(k, 'p', a)).toBe('secret text');
    expect(await seal(k, 'p', 'secret text')).not.toBe(a);
    expect(a).not.toContain('secret');
  });

  it('refuses another key, another purpose, and a changed value', async () => {
    const k = key();
    const a = await seal(k, 'p', 'secret text');
    await expect(open(key(), 'p', a)).rejects.toThrow(/does not open/);
    await expect(open(k, 'other', a)).rejects.toThrow(/does not open/);
    const [v, iv, data] = a.split('.');
    const flipped = `${v}.${iv}.${data.slice(0, -2)}${data.slice(-2) === 'AA' ? 'AB' : 'AA'}`;
    await expect(open(k, 'p', flipped)).rejects.toThrow(/does not open|not a sealed/);
    await expect(open(k, 'p', 'v2.x.y')).rejects.toThrow(/not a sealed value/);
  });

  it('refuses a missing or short hub key', async () => {
    await expect(seal(undefined, 'p', 'x')).rejects.toThrow(/not set or is not 32 bytes/);
    await expect(seal(btoa('short'), 'p', 'x')).rejects.toThrow(/not set or is not 32 bytes/);
    await expect(seal('%%not base64%%', 'p', 'x')).rejects.toThrow(/not set or is not 32 bytes/);
  });
});
