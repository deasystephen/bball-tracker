/**
 * Invitation expiry date. Fixed locale and UTC so the server render (Node, UTC
 * on any host) and the browser hydrate the same text; a bare
 * `toLocaleDateString()` differs near midnight and logs a hydration mismatch.
 */
export function formatExpiry(expiresAt: string): string {
  return new Date(expiresAt).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}
