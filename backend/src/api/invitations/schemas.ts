/**
 * Zod schemas for invitation API validation
 */

import { z } from 'zod';
import { GuardianRelationship } from '@prisma/client';

/**
 * Schema for creating a team invitation: invite an existing user by
 * `playerId`. With `supersede` this is the Resend path.
 *
 * The `{ name, email }` create-and-invite arm (audit #69) was removed in #418;
 * new players go through `POST /teams/:teamId/players` (`addRosterPlayerSchema`).
 * Unknown keys are stripped, so a pre-unification client that still sends
 * `{ name, email }` is answered 400 for the missing `playerId`.
 */
export const createInvitationSchema = z.object({
  playerId: z.string({ error: 'playerId is required' }).uuid('Invalid player ID format'),
  jerseyNumber: z.number().int().min(0).max(99).optional(),
  position: z.string().max(50).optional(),
  message: z.string().max(500).optional(),
  expiresInDays: z.number().int().min(1).max(30).default(7),
  // Resend: expire the player's current live PENDING invitation (if any) and
  // create a fresh one through this same path, in one transaction. Without
  // it a live PENDING invitation is a 400 (dedupe).
  supersede: z.boolean().default(false),
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
// Input shape (defaults optional) so service callers — tests included — can
// omit `supersede`/`expiresInDays`; the route always passes parsed output.
export type CreateInvitationInput = z.input<typeof createInvitationSchema>;
export type InvitationQueryParams = z.infer<typeof invitationQuerySchema>;
