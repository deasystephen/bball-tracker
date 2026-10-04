/**
 * Which account a data-subject request names (#648).
 *
 * `data-subject-request.ts` hands the id this returns to `AccountService` in
 * `operator` mode, where the owner/guardian gate is skipped by design, so the
 * row chosen here is the row that is exported or anonymised. The lookup
 * therefore goes through `emailEquals` like every other "which row holds this
 * email" filter (CLAUDE.md, Authorization): a raw `{ equals, mode:
 * 'insensitive' }` compiles to an unescaped ILIKE in which `_` matches any
 * character, so `jo_smith@` would also find `joXsmith@` and `findFirst` would
 * pick one of them at random.
 *
 * Two active rows can still match one address case-insensitively (legacy
 * mixed-case accounts, `User.email` is byte-unique only). That is refused
 * rather than resolved: the operator picks the row by id. The message carries
 * the count and the address the operator typed, never the matched rows.
 *
 * Kept apart from the CLI so `tests/integration/email-match.db.test.ts` can
 * prove it against a real Postgres without running the script.
 */

import type { PrismaClient } from '@prisma/client';
import { emailEquals } from '../src/utils/email-match';

type Db = Pick<PrismaClient, 'user'>;

/** Trim and lower-case, the same normalisation new accounts store. */
export function normaliseRequestEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * The id of the one active account holding `raw` (case-insensitive, `_` and
 * `%` literal). Throws when none or more than one matches.
 */
export async function findActiveUserIdByEmail(db: Db, raw: string): Promise<string> {
  const email = normaliseRequestEmail(raw);
  const users = await db.user.findMany({
    where: { email: emailEquals(email), deletedAt: null },
    select: { id: true },
  });
  if (users.length === 0) {
    throw new Error(`No active account with email ${email}`);
  }
  if (users.length > 1) {
    throw new Error(
      `${users.length} active accounts match ${email} case-insensitively; resolve by id before proceeding`
    );
  }
  return users[0].id;
}
