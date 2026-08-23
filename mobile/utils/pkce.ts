/**
 * PKCE (RFC 7636) + OAuth `state` for the WorkOS sign-in flow (audit #5).
 *
 * The app's redirect URI is a custom scheme (`bball-tracker://auth/callback`)
 * which any app on the device can claim. Without PKCE an app that intercepts
 * the redirect could exchange the authorization code for our user's session;
 * without `state`, a crafted deep link could log the victim into an
 * attacker-chosen account. So, per RFC 8252 §8.1:
 *
 *  1. `beginPkceLogin()` generates a random `verifier` + `state`, persists
 *     them (AsyncStorage — the app may be killed while the browser is open),
 *     and returns the S256 `codeChallenge` + `state` to send on `/auth/login`.
 *  2. The callback screen calls `consumePendingLogin(state)`, which only
 *     returns the verifier when the echoed `state` matches the pending one
 *     (and it has not expired). The entry is removed either way — single use.
 *  3. `/auth/callback` receives `code`, `state`, `code_verifier`; WorkOS
 *     refuses the exchange unless the verifier matches the challenge.
 *
 * No native module is required: randomness comes from expo-modules-core's
 * native UUID v4 generator (CSPRNG-backed on both platforms and already in
 * every binary), and SHA-256 is implemented below in plain JS so this ships
 * as an OTA update. `expo-crypto` is not in the app's binary (it would need a
 * native build).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { uuid } from 'expo-modules-core';

export const PENDING_LOGIN_KEY = 'auth:pending-login';
/** A sign-in that has sat in the browser longer than this is abandoned. */
export const PENDING_LOGIN_TTL_MS = 10 * 60 * 1000;

export interface PendingLogin {
  state: string;
  verifier: string;
  createdAt: number;
}

export interface PkceLoginParams {
  state: string;
  codeChallenge: string;
}

/**
 * Hex string of `count` native UUID v4s with the dashes removed
 * (~122 bits of entropy each). Output alphabet [0-9a-f] is valid for both
 * the PKCE verifier (RFC 7636 unreserved chars) and our `state` format.
 */
export function randomHex(count: number): string {
  let out = '';
  for (let i = 0; i < count; i += 1) {
    const id = uuid.v4();
    if (typeof id !== 'string' || id.length < 32) {
      throw new Error('Native UUID generator unavailable');
    }
    out += id.replace(/-/g, '');
  }
  return out;
}

// --- SHA-256 (FIPS 180-4), operating on a UTF-8 byte array ------------------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

function utf8Bytes(input: string): Uint8Array {
  const encoded = encodeURIComponent(input);
  const bytes: number[] = [];
  for (let i = 0; i < encoded.length; i += 1) {
    const ch = encoded[i];
    if (ch === '%') {
      bytes.push(parseInt(encoded.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(ch.charCodeAt(0));
    }
  }
  return Uint8Array.from(bytes);
}

export function sha256(input: string): Uint8Array {
  const msg = utf8Bytes(input);
  const bitLen = msg.length * 8;
  // Pad: 0x80, zeros, 64-bit big-endian length; total a multiple of 64 bytes.
  const padded = new Uint8Array(Math.ceil((msg.length + 9) / 64) * 64);
  padded.set(msg);
  padded[msg.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(padded.length - 4, bitLen >>> 0, false);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let t = 0; t < 16; t += 1) {
      w[t] = view.getUint32(offset + t * 4, false);
    }
    for (let t = 16; t < 64; t += 1) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, hh] = h;
    for (let t = 0; t < 64; t += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + S1 + ch + K[t] + w[t]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i += 1) {
    outView.setUint32(i * 4, h[i], false);
  }
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Base64url (RFC 4648 §5) without padding. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const triple = (b0 << 16) | (b1 << 8) | b2;
    out += B64[(triple >> 18) & 63] + B64[(triple >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(triple >> 6) & 63] : '';
    out += i + 2 < bytes.length ? B64[triple & 63] : '';
  }
  return out;
}

/** RFC 7636 §4.2: code_challenge = BASE64URL(SHA256(ASCII(code_verifier))). */
export function codeChallengeFor(verifier: string): string {
  return base64UrlEncode(sha256(verifier));
}

/**
 * Generate and persist a fresh verifier/state pair. Returns what the
 * authorization request needs. Any previous pending login is replaced.
 */
export async function beginPkceLogin(): Promise<PkceLoginParams> {
  const verifier = randomHex(3); // 96 hex chars, within RFC 7636's 43–128
  const state = randomHex(1); // 32 hex chars
  const pending: PendingLogin = { state, verifier, createdAt: Date.now() };
  await AsyncStorage.setItem(PENDING_LOGIN_KEY, JSON.stringify(pending));
  return { state, codeChallenge: codeChallengeFor(verifier) };
}

/**
 * Single-use lookup of the pending login for an echoed `state`. Returns
 * `null` (and clears the entry) when nothing is pending, the state does not
 * match, or the pending login has expired. Never throws on storage errors —
 * a failed read is treated as "nothing pending".
 */
export async function consumePendingLogin(state: string | undefined): Promise<PendingLogin | null> {
  let raw: string | null = null;
  try {
    raw = await AsyncStorage.getItem(PENDING_LOGIN_KEY);
  } catch {
    return null;
  }
  // Clear regardless of outcome so a replayed deep link cannot reuse it.
  AsyncStorage.removeItem(PENDING_LOGIN_KEY).catch(() => undefined);
  if (!raw || !state) return null;

  let pending: PendingLogin;
  try {
    pending = JSON.parse(raw) as PendingLogin;
  } catch {
    return null;
  }
  if (
    typeof pending?.state !== 'string' ||
    typeof pending?.verifier !== 'string' ||
    pending.state !== state ||
    Date.now() - pending.createdAt > PENDING_LOGIN_TTL_MS
  ) {
    return null;
  }
  return pending;
}
