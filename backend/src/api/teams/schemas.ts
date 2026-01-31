/**
 * Zod validation schemas for Teams API
 */

import { z } from 'zod';

/**
 * Schema for creating a new team
 */
export const createTeamSchema = z.object({
  name: z.string().min(1, 'Team name is required').max(100, 'Team name too long'),
  seasonId: z.string().uuid('Invalid season ID format'),
});

/**
 * Schema for updating a team
 */
export const updateTeamSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  seasonId: z.string().uuid().optional(),
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
 * Schema for adding a staff member to a team
 */
export const addStaffSchema = z.object({
  userId: z.string().uuid('Invalid user ID format'),
  roleName: z.string().min(1, 'Role name is required'),
});

/**
 * Schema for removing a staff member from a team
 */
export const removeStaffSchema = z.object({
  userId: z.string().uuid('Invalid user ID format'),
  roleName: z.string().min(1, 'Role name is required'),
});

/**
 * Schema for creating a custom team role
 */
export const createRoleSchema = z.object({
  name: z.string().min(1, 'Role name is required').max(50, 'Role name too long'),
  description: z.string().max(255).optional(),
  canManageTeam: z.boolean().optional().default(false),
  canManageRoster: z.boolean().optional().default(false),
  canTrackStats: z.boolean().optional().default(false),
  canViewStats: z.boolean().optional().default(true),
  canShareStats: z.boolean().optional().default(false),
});

/**
 * Schema for team query parameters
 */
export const teamQuerySchema = z.object({
  seasonId: z.string().uuid().optional(),
  leagueId: z.string().uuid().optional(),
  playerId: z.string().uuid().optional(), // Teams where this player is a member
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export type CreateTeamInput = z.infer<typeof createTeamSchema>;
export type UpdateTeamInput = z.infer<typeof updateTeamSchema>;
export type AddPlayerInput = z.infer<typeof addPlayerSchema>;
export type UpdateTeamMemberInput = z.infer<typeof updateTeamMemberSchema>;
export type AddStaffInput = z.infer<typeof addStaffSchema>;
export type RemoveStaffInput = z.infer<typeof removeStaffSchema>;
export type CreateRoleInput = z.infer<typeof createRoleSchema>;
export type TeamQueryParams = z.infer<typeof teamQuerySchema>;
