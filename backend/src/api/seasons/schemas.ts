/**
 * Zod validation schemas for Seasons API
 */

import { z } from 'zod';

/**
 * Schema for creating a new season
 */
export const createSeasonSchema = z.object({
  leagueId: z.string().min(1, 'League ID is required'),
  name: z.string().min(1, 'Season name is required').max(100, 'Season name too long'),
  // `.nullable()` must wrap the coercion: a bare `z.coerce.date()` turns
  // `null` into `new Date(null)` (1970-01-01) instead of rejecting/keeping it.
  startDate: z.coerce.date().nullable().optional(),
  endDate: z.coerce.date().nullable().optional(),
});

/**
 * Schema for updating a season
 */
export const updateSeasonSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  startDate: z.coerce.date().nullable().optional(),
  endDate: z.coerce.date().nullable().optional(),
  isActive: z.boolean().optional(),
});

/**
 * Schema for season query parameters
 */
export const seasonQuerySchema = z.object({
  leagueId: z.string().min(1).optional(),
  isActive: z
    .string()
    .transform((val) => val === 'true')
    .optional(),
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

export type CreateSeasonInput = z.infer<typeof createSeasonSchema>;
export type UpdateSeasonInput = z.infer<typeof updateSeasonSchema>;
export type SeasonQueryParams = z.infer<typeof seasonQuerySchema>;
