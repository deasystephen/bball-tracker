/**
 * Admin email allowlist.
 *
 * A user is granted the ADMIN role at first sign-up when their email is on the
 * allowlist. The allowlist is read from two env vars (merged), case-insensitive:
 *   - ADMIN_EMAILS: comma-separated list (preferred — the "admin group")
 *   - ADMIN_EMAIL:  single email (legacy; still honored for backward compatibility)
 *
 * Note: this governs role assignment at account creation only. Changing the
 * allowlist does NOT retroactively promote or demote existing accounts —
 * `syncUser` never rewrites the role of an existing user.
 */

/** Parsed, de-duplicated, lower-cased admin emails from the environment. */
export function getAdminEmails(): string[] {
  const raw = `${process.env.ADMIN_EMAILS ?? ''},${process.env.ADMIN_EMAIL ?? ''}`;
  const normalized = raw
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.length > 0);
  return [...new Set(normalized)];
}

/** True when `email` is on the admin allowlist (case-insensitive). */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) {
    return false;
  }
  return getAdminEmails().includes(email.trim().toLowerCase());
}
