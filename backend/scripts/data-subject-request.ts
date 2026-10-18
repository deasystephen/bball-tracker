/**
 * Operator CLI for data-subject requests (#444).
 * Runbook: docs/runbooks/data-subject-requests.md — verify the requester's
 * identity BEFORE running either command.
 *
 *   NODE_ENV=production npx tsx scripts/data-subject-request.ts export <email>   # JSON to stdout
 *   NODE_ENV=production npx tsx scripts/data-subject-request.ts delete <email>   # anonymize in place
 *
 * NODE_ENV=production keeps Prisma's development query log off stdout so the
 * export is pure JSON.
 *
 * Both run against DATABASE_URL. `delete` uses AccountService in `operator`
 * mode: the owner/guardian gate is skipped (identity was verified by hand),
 * the last-head-coach rule still applies, and the WorkOS user is deleted
 * best-effort after commit (the output says whether it succeeded).
 *
 * The address is matched exactly, case-insensitively, with `_` and `%`
 * literal (`emailEquals`, #648); when more than one active account matches
 * the script exits non-zero before exporting or deleting anything.
 */

// Loads backend/.env locally (DATABASE_URL for Prisma, WORKOS_* for `delete`,
// which is checked up front). In production run with the task's env.
import 'dotenv/config';
import prisma from '../src/models';
import { AccountService } from '../src/services/account-service';
import { assertWorkOSConfig } from '../src/utils/workos-client';
import { findActiveUserIdByEmail } from './data-subject-lookup';

async function main(argv: string[]): Promise<void> {
  const [command, email] = argv;
  if (!email || (command !== 'export' && command !== 'delete')) {
    process.stderr.write('usage: data-subject-request.ts <export|delete> <email>\n');
    process.exitCode = 2;
    return;
  }

  const userId = await findActiveUserIdByEmail(prisma, email);

  if (command === 'export') {
    const data = await AccountService.exportUserData(userId);
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return;
  }

  // Before anything is erased: a delete without WorkOS credentials would
  // anonymise the row and leave the identity-provider user behind. A row with
  // no workosUserId never reaches WorkOS, so it needs no credentials.
  const target = await prisma.user.findUnique({ where: { id: userId }, select: { workosUserId: true } });
  if (target?.workosUserId) {
    assertWorkOSConfig();
  }

  const result = await AccountService.deleteAccount(userId, { actorId: 'operator', mode: 'operator' });
  process.stdout.write(
    JSON.stringify(
      {
        userId,
        deleted: true,
        identityDeleted: result.identityDeleted,
        erased: result.erased,
        adminlessLeagueIds: result.adminlessLeagueIds,
      },
      null,
      2
    ) + '\n'
  );
}

main(process.argv.slice(2))
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
