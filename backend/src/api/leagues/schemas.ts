/**
 * Zod validation schemas for Leagues API
 */

import { z } from 'zod';

/**
 * Schema for creating a new league
 */
export const createLeagueSchema = z.object({
  name: z.string().min(1, 'League name is required').max(100, 'League name too long'),
});

/**
 * Schema for updating a league
 */
export const updateLeagueSchema = z.object({
  name: z.string().min(1).max(100).optional(),
});

/**
 * Schema for league query parameters
 */
export const leagueQuerySchema = z.object({
  search: z.string().optional(),
  // ADMIN-only escape hatch: personal leagues (#442) are excluded from admin
  // listings by default so they do not accumulate one row per coach.
  includePersonal: z
    .string()
    .transform((val) => val === 'true')
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

/**
 * Schema for `POST /leagues/:id/admins` — grant league-admin rights to a user.
 * User ids are UUIDs (unlike league/season ids, which are custom strings).
 */
export const addLeagueAdminSchema = z.object({
  userId: z.string().uuid('userId must be a valid UUID'),
});

export type CreateLeagueInput = z.infer<typeof createLeagueSchema>;
export type AddLeagueAdminInput = z.infer<typeof addLeagueAdminSchema>;
export type UpdateLeagueInput = z.infer<typeof updateLeagueSchema>;
export type LeagueQueryParams = z.infer<typeof leagueQuerySchema>;
