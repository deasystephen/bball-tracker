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

/**
 * Stored form of an address: trimmed and lower-cased before validation, as
 * every account-creating path stores it (#651). WorkOS presents lower-case
 * addresses and `syncUser` claims by exact match, so a mixed-case row would be
 * an unclaimable duplicate.
 */
const playerEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('Invalid email format')
  .max(255, 'Email too long');

export const createPlayerSchema = z.object({
  email: playerEmailSchema,
  name: z.string().min(1, 'Name is required').max(100, 'Name too long'),
  // Optional fields
  profilePictureUrl: safeUrlSchema.optional().or(z.literal('')),
});

/**
 * Schema for updating a player
 */
export const updatePlayerSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100, 'Name too long').optional(),
  email: playerEmailSchema.optional(),
  profilePictureUrl: safeUrlSchema.optional().or(z.literal('')),
});

/**
 * Schema for player query parameters
 */
export const playerQuerySchema = z.object({
  search: z.string().optional(), // Search by name (admins: name or email)
  // Admin-only filters — ignored for other callers (see PlayerService.listPlayers)
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
