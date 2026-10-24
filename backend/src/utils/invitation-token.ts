/**
 * The shape an invitation token must have before the public by-token routes
 * look it up (`api/invitations/public-routes.ts`; anything else is a 400).
 * Shared with `tests/support/seed-fixtures.test.ts`, which holds the fixed
 * Maestro fixture token to the same rule.
 */

const TOKEN_RE = /^[A-Za-z0-9\-_]+$/;

export function isValidInvitationTokenFormat(token: string): boolean {
  return TOKEN_RE.test(token) && token.length >= 8 && token.length <= 128;
}
