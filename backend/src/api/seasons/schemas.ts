/**
 * Zod validation schemas for Seasons API
 */

import { z } from 'zod';

/**
 * Schema for creating a new season
 */
export const createSeasonSchema = z.object({
  leagueId: z.string().uuid('Invalid league ID format'),
  name: z.string().min(1, 'Season name is required').max(100, 'Season name too long'),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
});

/**
 * Schema for updating a season
 */
export const updateSeasonSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  startDate: z.coerce.date().optional().nullable(),
  endDate: z.coerce.date().optional().nullable(),
  isActive: z.boolean().optional(),
});

/**
 * Schema for season query parameters
 */
export const seasonQuerySchema = z.object({
  leagueId: z.string().uuid().optional(),
  isActive: z
    .string()
    .transform((val) => val === 'true')
    .optional(),
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export type CreateSeasonInput = z.infer<typeof createSeasonSchema>;
export type UpdateSeasonInput = z.infer<typeof updateSeasonSchema>;
export type SeasonQueryParams = z.infer<typeof seasonQuerySchema>;
