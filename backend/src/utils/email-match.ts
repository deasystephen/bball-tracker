/**
 * The ONE way to ask "which row holds this email address" (#572).
 *
 * Addresses are compared case-insensitively: accounts created before the
 * lowercase rule can hold a mixed-case address, and an invitation must find
 * them anyway. Prisma compiles `{ equals, mode: 'insensitive' }` to `ILIKE`
 * and passes the value through as the PATTERN, unescaped, so `_` and `%` in
 * an address are wildcards:
 *
 *   first_last@example.com   also matches   firstXlast@example.com
 *
 * Underscores are common in real addresses, and these lookups decide whose
 * account an invitation, a staff role or a guardian link lands on. So every
 * such filter goes through `emailEquals`, which escapes the pattern
 * characters; `tests/utils/email-match-guard.test.ts` fails on a raw
 * `equals` + `mode: 'insensitive'` anywhere else in `src/`.
 *
 * `contains` + `mode: 'insensitive'` (player search) is a different thing and
 * stays as it is: a search box is meant to match loosely.
 *
 * Proven against Postgres in `tests/integration/email-match.db.test.ts` — a
 * mocked test cannot see how the filter compiles. That suite is also what
 * fails if a future Prisma starts escaping by itself (the double escape would
 * stop matching addresses that contain `_`).
 */

/** Backslash is the default `LIKE` / `ILIKE` escape character in Postgres. */
const LIKE_SPECIAL = /[\\_%]/g;

/** Escape `\`, `_` and `%` so the string matches only itself under `ILIKE`. */
export function escapeLikePattern(value: string): string {
  return value.replace(LIKE_SPECIAL, (char) => `\\${char}`);
}

export interface EmailEqualsFilter {
  equals: string;
  mode: 'insensitive';
}

/**
 * Prisma filter for "this exact address, in any case". Use it as the value of
 * an email column in a `where`:
 *
 *   prisma.user.findFirst({ where: { email: emailEquals(address) } })
 */
export function emailEquals(address: string): EmailEqualsFilter {
  return { equals: escapeLikePattern(address), mode: 'insensitive' };
}

/** True when two addresses are the same address, ignoring case and outer whitespace. */
export function isSameEmail(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
