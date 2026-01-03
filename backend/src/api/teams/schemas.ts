/**
 * Zod validation schemas for Teams API
 */

import { z } from 'zod';

/**
 * Schema for creating a new team
 */
export const createTeamSchema = z.object({
  name: z.string().min(1, 'Team name is required').max(100, 'Team name too long'),
  leagueId: z.string().uuid('Invalid league ID format'),
  coachId: z.string().uuid('Invalid coach ID format').optional(),
  // coachId is optional - if not provided, will use the authenticated user
});

/**
 * Schema for updating a team
 */
export const updateTeamSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  leagueId: z.string().uuid().optional(),
});

/**
 * Schema for adding a player to a team
 */
export const addPlayerSchema = z.object({
  playerId: z.string().uuid('Invalid player ID format'),
  jerseyNumber: z.number().int().min(0).max(99).optional(),
  position: z.string().max(50).optional(),
});

/**
 * Schema for updating a team member
 */
export const updateTeamMemberSchema = z.object({
  jerseyNumber: z.number().int().min(0).max(99).optional(),
  position: z.string().max(50).optional(),
});

/**
 * Schema for team query parameters
 */
export const teamQuerySchema = z.object({
  leagueId: z.string().uuid().optional(),
  coachId: z.string().uuid().optional(),
  playerId: z.string().uuid().optional(), // Teams where this player is a member
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export type CreateTeamInput = z.infer<typeof createTeamSchema>;
export type UpdateTeamInput = z.infer<typeof updateTeamSchema>;
export type AddPlayerInput = z.infer<typeof addPlayerSchema>;
export type UpdateTeamMemberInput = z.infer<typeof updateTeamMemberSchema>;
export type TeamQueryParams = z.infer<typeof teamQuerySchema>;
