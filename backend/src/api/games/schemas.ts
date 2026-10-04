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
export const updateGameSchema = z
  .object({
    opponent: z.string().min(1).max(100).optional(),
    date: z.string().datetime().or(z.date()).optional(),
    status: z.nativeEnum(GameStatus).optional(),
    homeScore: z.number().int().min(0).optional(),
    awayScore: z.number().int().min(0).optional(),
  })
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: 'At least one field must be provided',
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

// ============================================
// Game Event Schemas
// ============================================

import { GameEventType, RsvpStatus } from '@prisma/client';

const gameEventBaseShape = {
  playerId: z.string().uuid('Invalid player ID format').optional(),
  timestamp: z.string().datetime('Invalid timestamp format').or(z.date()).optional(),
};

/**
 * SHOT metadata is what `Game.homeScore` and the box score are derived from
 * (`utils/shot-points.ts#shotPointValue`), so its shape is exact: a boolean
 * `made` and a point value of 1, 2 or 3, nothing else (#723).
 */
export const shotMetadataSchema = z
  .object({
    made: z.boolean({ error: 'SHOT metadata.made must be a boolean' }),
    points: z.union([z.literal(1), z.literal(2), z.literal(3)], {
      error: 'SHOT metadata.points must be 1, 2 or 3',
    }),
  })
  .strict();

/** REBOUND metadata: the box score splits offensive and defensive rebounds on `type`. */
export const reboundMetadataSchema = z
  .object({
    type: z.enum(['offensive', 'defensive'], {
      error: 'REBOUND metadata.type must be offensive or defensive',
    }),
  })
  .strict();

/** Every event type except the two with an exact metadata shape, derived from the Prisma enum. */
const otherGameEventTypeSchema = z
  .enum(GameEventType)
  .exclude([GameEventType.SHOT, GameEventType.REBOUND]);

/**
 * Schema for creating a game event, discriminated on `eventType`: SHOT and
 * REBOUND carry the metadata the score and box score read, so it is required
 * and exact; every other type keeps a flat record of primitives.
 */
export const createGameEventSchema = z.discriminatedUnion(
  'eventType',
  [
    z.object({
      ...gameEventBaseShape,
      eventType: z.literal(GameEventType.SHOT),
      metadata: shotMetadataSchema,
    }),
    z.object({
      ...gameEventBaseShape,
      eventType: z.literal(GameEventType.REBOUND),
      metadata: reboundMetadataSchema,
    }),
    z.object({
      ...gameEventBaseShape,
      eventType: otherGameEventTypeSchema,
      metadata: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
        .optional()
        .default({}),
    }),
  ],
  { error: 'Invalid event type' }
);

/**
 * Schema for game event query parameters
 */
export const gameEventQuerySchema = z.object({
  eventType: z.nativeEnum(GameEventType).optional(),
  playerId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export type CreateGameEventInput = z.infer<typeof createGameEventSchema>;
export type GameEventQueryParams = z.infer<typeof gameEventQuerySchema>;

// ============================================
// RSVP Schemas
// ============================================

/**
 * Schema for creating/updating an RSVP
 */
export const upsertRsvpSchema = z.object({
  status: z.nativeEnum(RsvpStatus, {
    error: 'Status must be YES, NO, or MAYBE',
  }),
  /**
   * RSVP on behalf of a child: allowed when the caller is a guardian of
   * `playerId` and the player is rostered on the game's team. The RSVP row is
   * keyed on the player, not the guardian.
   */
  playerId: z.string().uuid('Invalid player ID format').optional(),
});

export type UpsertRsvpInput = z.infer<typeof upsertRsvpSchema>;
