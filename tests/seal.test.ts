import { describe, expect, it } from 'vitest';
import { isSeal, seal, sha256 } from '../src/net/seal';

const bytes = (s: string) => new TextEncoder().encode(s);

describe('seat seals (#192)', () => {
  it('SHA-256 matches the standard vectors, and Web Crypto’s across block boundaries', async () => {
    expect(sha256(bytes(''))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256(bytes('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256(bytes('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
    for (const n of [55, 56, 63, 64, 65, 119, 1000]) {
      const m = new Uint8Array(n).map((_, i) => (i * 31 + 7) & 255);
      const want = [...new Uint8Array(await crypto.subtle.digest('SHA-256', m))].map((b) => b.toString(16).padStart(2, '0')).join('');
      expect(sha256(m)).toBe(want);
    }
  });

  it('a seal is the same for the same token and room, differs by room, and none for no token', () => {
    const t = '0123456789abcdef0123456789abcdef';
    expect(seal(t, 'room.a')).toBe(seal(t, 'room.a'));
    expect(isSeal(seal(t, 'room.a'))).toBe(true);
    expect(seal(t, 'room.b')).not.toBe(seal(t, 'room.a'));
    expect(seal(t + '0', 'room.a')).not.toBe(seal(t, 'room.a'));
    expect(seal('', 'room.a')).toBe('');
    expect(isSeal('xyz')).toBe(false);
  });
});
