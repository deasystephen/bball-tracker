/**
 * Read the expiry of an access token without verifying it (#49).
 *
 * The socket client uses it to decide whether the stored token can carry a
 * reconnect and when to refresh ahead of expiry. The server stays the
 * authority: it verifies every token it is given.
 *
 * - WorkOS JWT: `exp` claim, epoch seconds.
 * - Dev token (`dev_<base64 JSON>`, development only): `exp`, epoch ms.
 *
 * Returns epoch milliseconds, or null when the token cannot be decoded or has
 * no numeric `exp`.
 */
export function tokenExpiresAt(token: string | null | undefined): number | null {
  if (!token) return null;
  try {
    if (token.startsWith('dev_')) {
      const payload = JSON.parse(atob(token.slice(4))) as { exp?: unknown };
      return typeof payload.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp : null;
    }
    const part = token.split('.')[1];
    if (!part) return null;
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded)) as { exp?: unknown };
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** True when the token decodes to an expiry that is still in the future. */
export function isTokenUnexpired(token: string | null | undefined, now: number = Date.now()): boolean {
  const expiresAt = tokenExpiresAt(token);
  return expiresAt !== null && expiresAt > now;
}
