/**
 * One jersey number per team (#1087).
 *
 * A number is held by a current member of the team: a `TeamMember` row with
 * that `jerseyNumber` (a deleted account's "Deleted user" roster entry too,
 * until the coach removes it). A PENDING invitation reserves nothing; its
 * number is applied at accept only if it is still free.
 *
 * Every write that sets a member's number calls this inside its transaction,
 * after `lockTeamRow` on the team, so two concurrent adds of the same number
 * serialise and the second sees the first. There is no unique index on
 * `(teamId, jerseyNumber)` yet: production had duplicate pairs before this
 * rule, and the index follows once they are resolved
 * (`docs/architecture/roster-and-invitations.md`, Jersey numbers).
 */

import type { Prisma } from '@prisma/client';
import { JerseyNumberTakenError } from './errors';

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
