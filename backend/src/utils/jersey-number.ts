/**
 * One jersey number per team (#1087).
 *
 * A number is held by a current member of the team: a `TeamMember` row with
 * that `jerseyNumber` (a deleted account's "Deleted user" roster entry too,
 * until the coach removes it). A PENDING invitation reserves nothing; its
 * number is applied at accept only if it is still free.
 *
 * Every write that INSERTS or CHANGES a member's number calls this inside its
 * transaction, after the team row lock, so two concurrent adds of one number
 * serialise and the second sees the first: Add Player cases 1 and 2,
 * `TeamService.addPlayer`, and `updateTeamMember` when the number differs
 * from the one the member wears (read again under the lock).
 *
 * Paths that do not take that locked check, and why:
 * - Sending an invitation (`createInvitation`, Add Player case 3) checks
 *   without a lock: it writes no member row, and a number taken by accept
 *   time is dropped there (`InvitationService.acceptedJerseyNumber`, which
 *   runs behind the lock and never refuses).
 * - Keeping one's own number is not checked: the mobile edit sheet always
 *   sends the number, so a position-only edit must save.
 * - Season rollover copies the source roster's numbers as they are
 *   (`createMany`): they are unique on the source team, so on the copy too.
 *
 * Behind the check stands a partial unique index,
 * `TeamMember_teamId_jerseyNumber_key` ON (teamId, jerseyNumber) WHERE
 * jerseyNumber IS NOT NULL (hand-written migration; Prisma cannot express
 * it). The locked check is what answers a coach, with the holder's name; the
 * index is the guarantee. A write that somehow reached the index without the
 * check (`orJerseyConflict`) answers a plain 409 with no holder, never a 500.
 */

import type { Prisma } from '@prisma/client';
import { ConflictError, JerseyNumberTakenError } from './errors';
import { isUniqueViolation, violatedConstraint } from './prisma-errors';

/** The partial unique index behind the rule (migration 20261123120000_team_member_jersey_unique). */
export const JERSEY_NUMBER_INDEX = 'TeamMember_teamId_jerseyNumber_key';

/** Who holds a number: the `jersey_number_taken` body's `playerId`, `playerName` and `playerDeletedAt`. */
export interface JerseyHolder {
  playerId: string;
  playerName: string;
  /** Set for a deleted account's roster entry, so a client renders its own label (#813). */
  playerDeletedAt: Date | null;
}

/**
 * The current member of `teamId` wearing `jerseyNumber`, other than
 * `exceptPlayerId` (the member being edited, so keeping one's own number is a
 * no-op). Null when the number is free or none was given: blank is always
 * allowed, and `0` is a number (`!= null`, never truthiness).
 */
export async function findJerseyHolder(
  db: Prisma.TransactionClient,
  teamId: string,
  jerseyNumber: number | null | undefined,
  exceptPlayerId?: string
): Promise<JerseyHolder | null> {
  if (jerseyNumber == null) {
    return null;
  }
  const holder = await db.teamMember.findFirst({
    where: {
      teamId,
      jerseyNumber,
      ...(exceptPlayerId ? { playerId: { not: exceptPlayerId } } : {}),
    },
    select: { playerId: true, player: { select: { name: true, deletedAt: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return holder
    ? { playerId: holder.playerId, playerName: holder.player.name, playerDeletedAt: holder.player.deletedAt }
    : null;
}

/** Throws the 409 `jersey_number_taken` when another member holds the number. */
export async function assertJerseyNumberFree(
  db: Prisma.TransactionClient,
  teamId: string,
  jerseyNumber: number | null | undefined,
  exceptPlayerId?: string
): Promise<void> {
  const holder = await findJerseyHolder(db, teamId, jerseyNumber, exceptPlayerId);
  if (holder && jerseyNumber != null) {
    throw new JerseyNumberTakenError({ jerseyNumber, ...holder });
  }
}

/**
 * Run a write that sets a member's jersey number. The locked check
 * (`assertJerseyNumberFree`) refuses a taken number before the write, with the
 * holder's name; this is the backstop for a write that reaches the unique
 * index anyway: a 409 instead of a 500. It is not a retry.
 */
export async function orJerseyConflict<T>(jerseyNumber: number | null | undefined, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (isUniqueViolation(err) && violatedConstraint(err).index === JERSEY_NUMBER_INDEX) {
      throw new ConflictError(
        jerseyNumber != null
          ? `Another player on this team already wears number ${jerseyNumber}.`
          : 'Another player on this team already wears that number.'
      );
    }
    throw err;
  }
}
