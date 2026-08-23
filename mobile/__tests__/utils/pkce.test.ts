/**
 * PKCE + state helpers (audit #5).
 *
 * Randomness comes from expo-modules-core's native UUID v4, which jest has no
 * implementation for — mocked here with deterministic values. SHA-256 /
 * base64url are checked against RFC 7636 Appendix B and FIPS 180-4 vectors.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import nodeCrypto from 'crypto';

import {
  sha256,
  base64UrlEncode,
  codeChallengeFor,
  randomHex,
  beginPkceLogin,
  consumePendingLogin,
  PENDING_LOGIN_KEY,
  PENDING_LOGIN_TTL_MS,
} from '../../utils/pkce';

const mockUuid = { queue: [] as string[], calls: 0 };
jest.mock('expo-modules-core', () => ({
  ...jest.requireActual('expo-modules-core'),
  uuid: {
    v4: () => {
      mockUuid.calls += 1;
      return mockUuid.queue.shift() ?? '12345678-1234-4234-8234-123456789abc';
    },
  },
}));

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

describe('sha256', () => {
  it.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    ],
    // 64 bytes exactly: the length word spills into a second block.
    ['a'.repeat(64), 'ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb'],
  ])('hashes %j to the FIPS 180-4 vector', (input, expected) => {
    expect(toHex(sha256(input))).toBe(expected);
  });

  it.each(['héllo', '日本語', 'emoji 🏀', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(1000)])(
    'matches node:crypto for %j (UTF-8 + padding edges)',
    (input) => {
      const expected = nodeCrypto.createHash('sha256').update(input, 'utf8').digest('hex');
      expect(toHex(sha256(input))).toBe(expected);
    }
  );
});

describe('base64UrlEncode', () => {
  it('encodes without padding using the URL-safe alphabet', () => {
    expect(base64UrlEncode(Uint8Array.from([]))).toBe('');
    expect(base64UrlEncode(Uint8Array.from([0x66]))).toBe('Zg');
    expect(base64UrlEncode(Uint8Array.from([0x66, 0x6f]))).toBe('Zm8');
    expect(base64UrlEncode(Uint8Array.from([0x66, 0x6f, 0x6f]))).toBe('Zm9v');
    expect(base64UrlEncode(Uint8Array.from([0xfb, 0xff, 0xbf]))).toBe('-_-_');
  });
});

describe('codeChallengeFor', () => {
  it('matches RFC 7636 Appendix B', () => {
    expect(codeChallengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
    );
  });
});

describe('randomHex', () => {
  beforeEach(() => {
    mockUuid.queue = [];
    mockUuid.calls = 0;
  });

  it('concatenates native UUID v4s with dashes stripped', () => {
    mockUuid.queue = ['aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'ffffffff-0000-4111-8222-333333333333'];
    expect(randomHex(2)).toBe('aaaaaaaabbbb4ccc8dddeeeeeeeeeeeeffffffff000041118222333333333333');
    expect(mockUuid.calls).toBe(2);
  });

  it('throws instead of silently producing a weak value when the native generator is missing', () => {
    mockUuid.queue = ['nope'];
    expect(() => randomHex(1)).toThrow('Native UUID generator unavailable');
  });
});

describe('beginPkceLogin / consumePendingLogin', () => {
  beforeEach(async () => {
    mockUuid.queue = [];
    await AsyncStorage.clear();
    jest.useRealTimers();
  });

  it('persists a verifier + state and returns the S256 challenge', async () => {
    const { state, codeChallenge } = await beginPkceLogin();

    expect(state).toMatch(/^[0-9a-f]{32}$/);
    expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const stored = JSON.parse((await AsyncStorage.getItem(PENDING_LOGIN_KEY)) as string);
    expect(stored.state).toBe(state);
    expect(stored.verifier).toMatch(/^[0-9a-f]{96}$/);
    expect(codeChallengeFor(stored.verifier)).toBe(codeChallenge);
  });

  it('returns the verifier for the matching state and clears the entry (single use)', async () => {
    const { state } = await beginPkceLogin();

    const pending = await consumePendingLogin(state);
    expect(pending?.state).toBe(state);
    expect(pending?.verifier).toMatch(/^[0-9a-f]{96}$/);

    expect(await AsyncStorage.getItem(PENDING_LOGIN_KEY)).toBeNull();
    expect(await consumePendingLogin(state)).toBeNull();
  });

  it('rejects a mismatched, missing or absent state and still clears the entry', async () => {
    await beginPkceLogin();
    expect(await consumePendingLogin('0'.repeat(32))).toBeNull();
    expect(await AsyncStorage.getItem(PENDING_LOGIN_KEY)).toBeNull();

    const { state } = await beginPkceLogin();
    expect(await consumePendingLogin(undefined)).toBeNull();
    expect(await consumePendingLogin(state)).toBeNull(); // already cleared
  });

  it('rejects an expired pending login', async () => {
    const { state } = await beginPkceLogin();
    const stored = JSON.parse((await AsyncStorage.getItem(PENDING_LOGIN_KEY)) as string);
    stored.createdAt = Date.now() - PENDING_LOGIN_TTL_MS - 1;
    await AsyncStorage.setItem(PENDING_LOGIN_KEY, JSON.stringify(stored));

    expect(await consumePendingLogin(state)).toBeNull();
  });

  it('treats corrupt storage as nothing pending', async () => {
    await AsyncStorage.setItem(PENDING_LOGIN_KEY, '{not json');
    expect(await consumePendingLogin('x'.repeat(32))).toBeNull();

    await AsyncStorage.setItem(PENDING_LOGIN_KEY, JSON.stringify({ state: 1 }));
    expect(await consumePendingLogin('1')).toBeNull();
  });

  it('treats a storage read failure as nothing pending', async () => {
    const spy = jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('disk'));
    expect(await consumePendingLogin('x'.repeat(32))).toBeNull();
    spy.mockRestore();
  });

  it('a new login replaces the previous pending entry', async () => {
    const first = await beginPkceLogin();
    const second = await beginPkceLogin();
    expect(await consumePendingLogin(first.state)).toBeNull();
    expect(await consumePendingLogin(second.state)).toBeNull(); // single slot, already cleared above
  });
});
