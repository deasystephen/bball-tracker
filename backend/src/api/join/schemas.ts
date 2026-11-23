/**
 * Zod schemas for team join links (#210).
 */

import { z } from 'zod';
import { GuardianRelationship } from '@prisma/client';

/** Longest life a coach may give a link; the default is `JOIN_LINK_DEFAULT_EXPIRES_DAYS` (14). */
export const JOIN_LINK_MAX_EXPIRES_DAYS = 30;
/** Upper bound for `maxUses`: far above any roster, low enough to mean something. */
export const JOIN_LINK_MAX_USES = 500;

/**
 * `POST /teams/:teamId/join-link`: create the team's link (and revoke the
 * live one). Both fields are optional: the lifetime defaults to 14 days and
 * `maxUses` to no cap (`null` says so explicitly). Every link expires; there
 * is no "never".
 */
export const createJoinLinkSchema = z.object({
  expiresInDays: z
    .number()
    .int('expiresInDays must be a whole number')
    .min(1, 'expiresInDays must be at least 1')
    .max(JOIN_LINK_MAX_EXPIRES_DAYS, `expiresInDays must be at most ${JOIN_LINK_MAX_EXPIRES_DAYS}`)
    .optional(),
  maxUses: z
    .number()
    .int('maxUses must be a whole number')
    .min(1, 'maxUses must be at least 1')
    .max(JOIN_LINK_MAX_USES, `maxUses must be at most ${JOIN_LINK_MAX_USES}`)
    .nullable()
    .optional(),
});

/**
 * `POST /join/:token`: who the signed-in account is asking for.
 *  - `{ kind: 'self' }`: the account holder joins as a player.
 *  - `{ kind: 'child', childName, relationship }`: a parent adds their child,
 *    who becomes a managed roster record on approval. No email, no age and no
 *    date of birth is accepted for a child (unknown keys are stripped).
 */
export const joinRequestSchema = z.discriminatedUnion(
  'kind',
  [
    z.object({ kind: z.literal('self') }),
    z.object({
      kind: z.literal('child'),
      childName: z
        .string({ error: 'childName is required' })
        .trim()
        .min(1, 'Name is required')
        .max(100, 'Name too long'),
      relationship: z.nativeEnum(GuardianRelationship, {
        error: 'Relationship must be MOTHER, FATHER, GUARDIAN or OTHER',
      }),
    }),
  ],
  { error: 'kind must be self or child' }
);

/**
 * `POST /teams/:teamId/join-requests/:requestId/approve` (#1072). An empty
 * body approves as before (SELF joins; CHILD creates a new roster record).
 * `{ playerId }` approves a CHILD request onto that existing managed roster
 * record of the team instead, which must have no guardian yet. Unknown keys
 * are stripped.
 */
export const approveJoinRequestSchema = z.object({
  playerId: z.string({ error: 'playerId must be a string' }).uuid('playerId must be a valid UUID').optional(),
});

export type CreateJoinLinkInput = z.infer<typeof createJoinLinkSchema>;
export type JoinRequestInput = z.infer<typeof joinRequestSchema>;
export type ApproveJoinRequestInput = z.infer<typeof approveJoinRequestSchema>;
