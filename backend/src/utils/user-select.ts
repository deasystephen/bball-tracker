/**
 * The one user shape every service payload embeds for a person: a roster
 * player, a staff member, an RSVP, an announcement author, an invitation's
 * sender, a game event's player (#813).
 *
 * `deletedAt` is the tombstone signal: deleted accounts stay on rosters, sent
 * invitations and history (#444), and clients derive a localized label from
 * it, never from the stored name (CLAUDE.md, Data and invariants). `isManaged`
 * lets clients label roster-only players (audit #64).
 *
 * A hand-rolled `{ id, name }` select on a `user`, `player`, `author` or
 * `invitedBy` key fails `tests/utils/user-select-guard.test.ts`: spread one of
 * these constants or select `deletedAt` too.
 */
import { Prisma } from '@prisma/client';

/** No email: safe for every reader of the payload. */
export const USER_SUMMARY_SELECT = {
  id: true,
  name: true,
  isManaged: true,
  deletedAt: true,
} satisfies Prisma.UserSelect;

/**
 * Adds `email`, for the payloads whose readers may see addresses
 * (`docs/architecture/authorization.md`): staff emails go to every team
 * member, roster `player.email` only to callers with `canManageRoster`, so a
 * roster payload built on this constant strips the field for everyone else.
 */
export const USER_SUMMARY_WITH_EMAIL_SELECT = {
  ...USER_SUMMARY_SELECT,
  email: true,
} satisfies Prisma.UserSelect;

export type UserSummary = Prisma.UserGetPayload<{ select: typeof USER_SUMMARY_SELECT }>;
export type UserSummaryWithEmail = Prisma.UserGetPayload<{ select: typeof USER_SUMMARY_WITH_EMAIL_SELECT }>;
