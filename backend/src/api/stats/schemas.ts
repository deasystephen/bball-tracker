/**
 * Zod validation schemas for Stats API
 */

import { z } from 'zod';

/**
 * Schema for player season stats query parameters
 */
export const playerSeasonStatsQuerySchema = z.object({
  teamId: z.string().uuid('Invalid team ID format').optional(),
});

export type PlayerSeasonStatsQuery = z.infer<typeof playerSeasonStatsQuerySchema>;
