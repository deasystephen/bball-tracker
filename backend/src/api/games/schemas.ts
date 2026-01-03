/**
 * Zod validation schemas for Games API
 */

import { z } from 'zod';
import { GameStatus } from '@prisma/client';

/**
 * Schema for creating a new game
 */
export const createGameSchema = z.object({
  teamId: z.string().uuid('Invalid team ID format'),
  opponent: z.string().min(1, 'Opponent name is required').max(100, 'Opponent name too long'),
  date: z.string().datetime('Invalid date format').or(z.date()),
  status: z.nativeEnum(GameStatus).optional().default('SCHEDULED'),
  homeScore: z.number().int().min(0).optional().default(0),
  awayScore: z.number().int().min(0).optional().default(0),
});

/**
 * Schema for updating a game
 */
export const updateGameSchema = z.object({
  opponent: z.string().min(1).max(100).optional(),
  date: z.string().datetime().or(z.date()).optional(),
  status: z.nativeEnum(GameStatus).optional(),
  homeScore: z.number().int().min(0).optional(),
  awayScore: z.number().int().min(0).optional(),
});

/**
 * Schema for game query parameters
 */
export const gameQuerySchema = z.object({
  teamId: z.string().uuid().optional(),
  status: z.nativeEnum(GameStatus).optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export type CreateGameInput = z.infer<typeof createGameSchema>;
export type UpdateGameInput = z.infer<typeof updateGameSchema>;
export type GameQueryParams = z.infer<typeof gameQuerySchema>;
