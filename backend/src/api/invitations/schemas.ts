/**
 * Zod schemas for invitation API validation
 */

import { z } from 'zod';
import { GuardianRelationship } from '@prisma/client';

/**
 * Schema for creating a team invitation.
 *
 * Either invite an existing user by `playerId`, or create-and-invite a new
 * player in one call with `name` + `email` (audit #69: the old two-step
 * create-player-then-invite left an orphan user when the second call failed).
 */
export const createInvitationSchema = z
  .object({
    playerId: z.string().uuid('Invalid player ID format').optional(),
    name: z.string().trim().min(1, 'Name is required').max(100, 'Name too long').optional(),
    email: z.string().trim().email('Invalid email format').max(255).optional(),
    profilePictureUrl: z
      .string()
      .url()
      .refine((url) => url.startsWith('https://') || url.startsWith('http://'), {
        message: 'URL must use http or https protocol',
      })
      .optional(),
    jerseyNumber: z.number().int().min(0).max(99).optional(),
    position: z.string().max(50).optional(),
    message: z.string().max(500).optional(),
    expiresInDays: z.number().int().min(1).max(30).default(7),
  })
  .superRefine((data, ctx) => {
    const hasPlayerId = data.playerId !== undefined;
    const hasNewPlayerField =
      data.name !== undefined || data.email !== undefined || data.profilePictureUrl !== undefined;

    if (hasPlayerId && hasNewPlayerField) {
      ctx.addIssue({
        code: 'custom',
        message: 'Provide either playerId or name and email, not both',
      });
    } else if (!hasPlayerId && !(data.name && data.email)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Provide playerId, or name and email to create and invite a new player',
      });
    }
  });

/**
 * Schema for invitation query parameters
 */
export const invitationQuerySchema = z.object({
  status: z.enum(['PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED']).optional(),
  teamId: z.string().uuid().optional(),
  playerId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * Schema for inviting a guardian (PARENT role) for a rostered player:
 * `POST /teams/:teamId/members/:playerId/guardians`.
 */
export const inviteGuardianSchema = z.object({
  email: z.string().trim().email('Invalid email format').max(255),
  relationship: z.nativeEnum(GuardianRelationship, {
    error: 'Relationship must be MOTHER, FATHER, GUARDIAN or OTHER',
  }),
});

export type InviteGuardianInput = z.infer<typeof inviteGuardianSchema>;
export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;
export type InvitationQueryParams = z.infer<typeof invitationQuerySchema>;
