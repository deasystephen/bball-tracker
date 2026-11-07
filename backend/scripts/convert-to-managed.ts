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
 * then the WorkOS user is deleted best-effort, which ends its sessions. The
 * output says which coach now manages the record and whether the WorkOS
 * deletion succeeded. When it failed, the active sessions are revoked as a
 * stopgap, the output carries the WorkOS user id (the row no longer does) and
 * the session outcome, a warning goes to stderr and the exit code is 3: the
 * operator deletes the WorkOS user by hand before replying to the reporter.
 * A WorkOS 404 counts as deleted (`identityNote: not_found_at_workos`). When
 * the S3 delete of the cleared photo fails (`photoDeletion: failed`) the exit
 * code is 4 (3 wins when both failed) and the operator deletes the object by
 * hand. The WorkOS credentials and `S3_AVATARS_BUCKET` are checked before
 * anything is written.
 * `expiredGuardianInvitations` lists pending guardian invitations sent to the
 * child's address (with the child each was for) that were expired: the
 * operator asks each child's coach to re-invite at a parent's address.
 *
 * A refusal writes nothing, exits 1 and prints the service's reason plus what
 * to do next, keyed on the refusal code (`ConvertRefusedError.code`).
 */

// Loads backend/.env locally (DATABASE_URL, WORKOS_*). In production run with the task's env.
import 'dotenv/config';
import prisma from '../src/models';
import { AccountService } from '../src/services/account-service';
import { ConvertRefusedError, type ConvertRefusalCode } from '../src/utils/errors';
import { assertAvatarStorageConfig } from '../src/services/upload-service';
import { assertWorkOSConfig } from '../src/utils/workos-client';

const USAGE = 'usage: convert-to-managed.ts <userId> [--coach <coachUserId>]\n';

/** What the operator does next for each refusal; the runbook lists the same. */
const NEXT_STEP: Record<ConvertRefusalCode, string> = {
  already_managed: 'Nothing to do: the record was converted already.',
  never_signed_in: 'Nothing to convert: the child never signed in. Nothing to un-claim.',
  adult_account: 'Verify the report again; if it holds, delete the account with data-subject-request.ts delete.',
  personal_league_in_use: 'Verify the report again; if it holds, delete the account with data-subject-request.ts delete.',
  coach_not_on_team: "Pass --coach with a staff member of one of the child's active-season teams.",
  no_active_team: 'There is no roster to keep the record on: delete the account with data-subject-request.ts delete.',
  no_head_coach: "Pass --coach with a staff member of the child's active-season team.",
  several_head_coaches: 'Pass --coach with the head coach who should keep the record.',
  coach_unavailable: 'Run it again, or pass --coach with another staff member.',
  coaches_changed: 'Run it again.',
};

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

  // Before anything is written: every convertible row has a WorkOS identity,
  // and converting without the credentials would leave it (and its sessions)
  // behind; without the avatar bucket a photo of the child would be left in S3.
  assertWorkOSConfig();
  assertAvatarStorageConfig();

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
        ...(result.identityNote && { identityNote: result.identityNote }),
        photoDeletion: result.photoDeletion,
        expiredGuardianInvitations: result.expiredGuardianInvitations,
        deletedReplyCount: result.deletedReplyCount,
        ...(!result.identityDeleted && { workosUserId: result.workosUserId, sessions: result.sessions }),
      },
      null,
      2
    ) + '\n'
  );

  if (result.expiredGuardianInvitations.length > 0) {
    const children = [...new Set(result.expiredGuardianInvitations.map((invitation) => invitation.childId))];
    process.stderr.write(
      `\nNote: ${result.expiredGuardianInvitations.length} pending guardian invitation(s) sent to the child's address were expired, ` +
        `for child id(s) ${children.join(', ')}. Ask each child's coach to re-invite the parent at a parent's own address.\n`
    );
  }

  if (result.identityNote === 'not_found_at_workos') {
    process.stderr.write(
      '\nNote: WorkOS has no user with this id (already deleted, or a Staging id from before the production-key cutover). Nothing to delete there.\n'
    );
  }

  if (result.photoDeletion === 'failed') {
    // Committed: the row no longer shows the photo, so nobody can find the
    // object again but us.
    process.stderr.write(
      '\n!!! The photo object was NOT deleted from S3 (see the "Failed to delete avatar object" log line for its URL).\n' +
        '!!! Delete it by hand before replying to the reporter.\n'
    );
    process.exitCode = 4;
  }

  if (!result.identityDeleted) {
    // The row is converted, but the identity-provider user survives: a new
    // sign-in would create a fresh account for the child. Exit non-zero so
    // nobody reads this run as finished.
    const sessions = result.sessions ?? null;
    const sessionLine =
      sessions === null
        ? '!!! Its sessions could not even be listed: nothing was revoked. Delete the user immediately.'
        : sessions.failed > 0
          ? `!!! Sessions NOT fully revoked: ${sessions.revoked} revoked, ${sessions.failed} failed. Delete the user immediately.`
          : `!!! Revoked ${sessions.revoked} active session(s) as a stopgap.`;
    process.stderr.write(
      [
        '',
        '!!! WorkOS user NOT deleted. The conversion is committed; the child can still sign in.',
        `!!! Delete WorkOS user ${result.workosUserId} in the WorkOS dashboard NOW, before replying to the reporter.`,
        sessionLine,
        '',
      ].join('\n')
    );
    process.exitCode = 3;
  }
}

main(process.argv.slice(2))
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const next = error instanceof ConvertRefusedError ? `. ${NEXT_STEP[error.code]}` : '';
    process.stderr.write(`${message}${next}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
