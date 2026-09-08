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
 */

// Loads backend/.env locally (WORKOS_API_KEY is required at import time by the
// WorkOS client; DATABASE_URL by Prisma). In production run with the task's env.
import 'dotenv/config';
import prisma from '../src/models';
import { AccountService } from '../src/services/account-service';

async function findUserIdByEmail(email: string): Promise<string> {
  const user = await prisma.user.findFirst({
    where: { email: { equals: email, mode: 'insensitive' }, deletedAt: null },
    select: { id: true },
  });
  if (!user) {
    throw new Error(`No active account with email ${email}`);
  }
  return user.id;
}

async function main(argv: string[]): Promise<void> {
  const [command, email] = argv;
  if (!email || (command !== 'export' && command !== 'delete')) {
    process.stderr.write('usage: data-subject-request.ts <export|delete> <email>\n');
    process.exitCode = 2;
    return;
  }

  const userId = await findUserIdByEmail(email);

  if (command === 'export') {
    const data = await AccountService.exportUserData(userId);
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return;
  }

  const result = await AccountService.deleteAccount(userId, { actorId: 'operator', mode: 'operator' });
  process.stdout.write(
    JSON.stringify(
      {
        userId,
        deleted: true,
        identityDeleted: result.identityDeleted,
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
