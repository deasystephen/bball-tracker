/**
 * Operator CLI: turn an account held by a child under 13 back into a managed
 * roster record (#983).
 * Runbook: docs/runbooks/data-subject-requests.md, "We learned an account
 * holder is under 13" — verify the reporter BEFORE running this.
 *
 *   NODE_ENV=production npx tsx scripts/convert-to-managed.ts <userId>
 *   NODE_ENV=production npx tsx scripts/convert-to-managed.ts <userId> --coach <coachUserId>
 *
 * Runs `AccountService.convertToManaged` against DATABASE_URL: one
 * transaction un-claims the row (no login, no email, managed by the coach),
 * then the WorkOS user is deleted best-effort, which ends every session. The
 * output says which coach now manages the record and whether the WorkOS
 * deletion succeeded. When it did not, the active sessions are revoked as a
 * stopgap, the output carries the WorkOS user id (the row no longer does), a
 * warning goes to stderr and the exit code is 3: the operator deletes the
 * WorkOS user by hand before replying to the reporter.
 *
 * Without `--coach` the record goes to the one head coach of the player's
 * teams in active seasons; the script refuses (exit 1, nothing written) when
 * there is none or more than one, when a named coach is not staff on one of
 * those teams, and when the account holds a staff role, a league admin role,
 * a guardian link or a personal league with teams (an adult account: delete
 * it with `data-subject-request.ts` instead).
 */

// Loads backend/.env locally (DATABASE_URL, WORKOS_*). In production run with the task's env.
import 'dotenv/config';
import prisma from '../src/models';
import { AccountService } from '../src/services/account-service';
import { assertWorkOSConfig } from '../src/utils/workos-client';

const USAGE = 'usage: convert-to-managed.ts <userId> [--coach <coachUserId>]\n';

function parseArgs(argv: string[]): { userId: string; coachId?: string } | null {
  const [userId, ...rest] = argv;
  if (!userId || userId.startsWith('-')) return null;
  if (rest.length === 0) return { userId };
  if (rest.length === 2 && rest[0] === '--coach' && rest[1] && !rest[1].startsWith('-')) {
    return { userId, coachId: rest[1] };
  }
  return null;
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (!args) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }

  // Before anything is written: a conversion without WorkOS credentials would
  // un-claim the row and leave the identity-provider user (and its sessions)
  // behind. A row with no workosUserId never reaches WorkOS.
  const target = await prisma.user.findUnique({ where: { id: args.userId }, select: { workosUserId: true } });
  if (target?.workosUserId) {
    assertWorkOSConfig();
  }

  const result = await AccountService.convertToManaged(args.userId, {
    actorId: 'operator',
    managedById: args.coachId,
  });
  process.stdout.write(
    JSON.stringify(
      {
        userId: args.userId,
        converted: true,
        managedById: result.managedById,
        identityDeleted: result.identityDeleted,
        ...(result.workosUserId && { workosUserId: result.workosUserId, sessionsRevoked: result.sessionsRevoked }),
      },
      null,
      2
    ) + '\n'
  );

  if (result.workosUserId) {
    // The row is converted, but the identity-provider user survives: a new
    // sign-in would create a fresh account for the child. Exit non-zero so
    // nobody reads this run as finished.
    process.stderr.write(
      [
        '',
        '!!! WorkOS user NOT deleted. The conversion is committed; the child can still sign in.',
        `!!! Delete WorkOS user ${result.workosUserId} in the WorkOS dashboard NOW, before replying to the reporter.`,
        result.sessionsRevoked === null
          ? '!!! Revoking its sessions failed too: delete the user immediately.'
          : `!!! Revoked ${result.sessionsRevoked} active session(s) as a stopgap.`,
        '',
      ].join('\n')
    );
    process.exitCode = 3;
  }
}

main(process.argv.slice(2))
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
