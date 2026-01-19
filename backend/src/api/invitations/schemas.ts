/**
 * Zod schemas for invitation API validation
 */

import { z } from 'zod';

/**
 * Schema for creating a team invitation
 */
export const createInvitationSchema = z.object({
  playerId: z.string().uuid('Invalid player ID format'),
  jerseyNumber: z.number().int().min(0).max(99).optional(),
  position: z.string().max(50).optional(),
  message: z.string().max(500).optional(),
  expiresInDays: z.number().int().min(1).max(30).default(7),
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

export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;
export type InvitationQueryParams = z.infer<typeof invitationQuerySchema>;
