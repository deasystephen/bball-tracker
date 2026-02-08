/**
 * Zod schemas for player API validation
 */

import { z } from 'zod';

/**
 * Schema for creating a player
 */
const safeUrlSchema = z.string().url('Invalid URL format').refine(
  (url) => /^https?:\/\//i.test(url),
  { message: 'URL must use http or https protocol' }
);

export const createPlayerSchema = z.object({
  email: z.string().email('Invalid email format'),
  name: z.string().min(1, 'Name is required').max(100, 'Name too long'),
  // Optional fields
  profilePictureUrl: safeUrlSchema.optional().or(z.literal('')),
});

/**
 * Schema for updating a player
 */
export const updatePlayerSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100, 'Name too long').optional(),
  email: z.string().email('Invalid email format').optional(),
  profilePictureUrl: safeUrlSchema.optional().or(z.literal('')),
});

/**
 * Schema for player query parameters
 */
export const playerQuerySchema = z.object({
  search: z.string().optional(), // Search by name or email
  role: z.enum(['PLAYER', 'COACH', 'PARENT', 'ADMIN']).optional(),
  isManaged: z.preprocess(
    (val) => val === 'true' ? true : val === 'false' ? false : val,
    z.boolean().optional()
  ),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export type CreatePlayerInput = z.infer<typeof createPlayerSchema>;
export type UpdatePlayerInput = z.infer<typeof updatePlayerSchema>;
export type PlayerQueryParams = z.infer<typeof playerQuerySchema>;
