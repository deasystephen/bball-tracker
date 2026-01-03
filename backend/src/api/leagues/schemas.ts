/**
 * Zod validation schemas for Leagues API
 */

import { z } from 'zod';

/**
 * Schema for creating a new league
 */
export const createLeagueSchema = z.object({
  name: z.string().min(1, 'League name is required').max(100, 'League name too long'),
  season: z.string().min(1, 'Season is required').max(50, 'Season name too long'),
  year: z.number().int().min(2000).max(2100),
});

/**
 * Schema for updating a league
 */
export const updateLeagueSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  season: z.string().min(1).max(50).optional(),
  year: z.number().int().min(2000).max(2100).optional(),
});

/**
 * Schema for league query parameters
 */
export const leagueQuerySchema = z.object({
  year: z.coerce.number().int().optional(),
  season: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export type CreateLeagueInput = z.infer<typeof createLeagueSchema>;
export type UpdateLeagueInput = z.infer<typeof updateLeagueSchema>;
export type LeagueQueryParams = z.infer<typeof leagueQuerySchema>;
