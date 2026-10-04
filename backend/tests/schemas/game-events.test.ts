/**
 * Schema tests for POST /games/:gameId/events (#723).
 *
 * SHOT and REBOUND metadata feed `Game.homeScore` and the box score, so their
 * shape is exact; every other event type keeps a flat record of primitives.
 */

import { GameEventType } from '@prisma/client';
import { createGameEventSchema } from '../../src/api/games/schemas';

const PLAYER_ID = '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

function messages(body: unknown): string[] {
  const result = createGameEventSchema.safeParse(body);
  expect(result.success).toBe(false);
  return result.error?.issues.map((issue) => issue.message) ?? [];
}

describe('createGameEventSchema', () => {
  describe('SHOT', () => {
    it.each([1, 2, 3])('accepts a made or missed %i-point shot', (points) => {
      for (const made of [true, false]) {
        const result = createGameEventSchema.safeParse({
          eventType: 'SHOT',
          playerId: PLAYER_ID,
          metadata: { made, points },
        });
        expect(result.success).toBe(true);
        expect(result.data?.metadata).toEqual({ made, points });
      }
    });

    it.each([0, 4, -5, 2.5, '2', null])('rejects points %p', (points) => {
      expect(messages({ eventType: 'SHOT', metadata: { made: true, points } })).toContain(
        'SHOT metadata.points must be 1, 2 or 3'
      );
    });

    it('rejects missing points', () => {
      expect(messages({ eventType: 'SHOT', metadata: { made: true } })).toContain(
        'SHOT metadata.points must be 1, 2 or 3'
      );
    });

    it.each(['yes', 1, null, undefined])('rejects made %p', (made) => {
      expect(messages({ eventType: 'SHOT', metadata: { made, points: 2 } })).toContain(
        'SHOT metadata.made must be a boolean'
      );
    });

    it('rejects missing metadata', () => {
      expect(createGameEventSchema.safeParse({ eventType: 'SHOT', playerId: PLAYER_ID }).success).toBe(
        false
      );
    });

    it('rejects extra metadata keys', () => {
      expect(
        createGameEventSchema.safeParse({
          eventType: 'SHOT',
          metadata: { made: true, points: 2, quarter: 1 },
        }).success
      ).toBe(false);
    });
  });

  describe('REBOUND', () => {
    it.each(['offensive', 'defensive'])('accepts type %s', (type) => {
      const result = createGameEventSchema.safeParse({
        eventType: 'REBOUND',
        playerId: PLAYER_ID,
        metadata: { type },
      });
      expect(result.success).toBe(true);
      expect(result.data?.metadata).toEqual({ type });
    });

    it.each(['team', '', null])('rejects type %p', (type) => {
      expect(messages({ eventType: 'REBOUND', metadata: { type } })).toContain(
        'REBOUND metadata.type must be offensive or defensive'
      );
    });

    it('rejects missing metadata', () => {
      expect(createGameEventSchema.safeParse({ eventType: 'REBOUND', playerId: PLAYER_ID }).success).toBe(
        false
      );
    });
  });

  describe('other event types', () => {
    it.each(
      Object.values(GameEventType).filter(
        (type) => type !== GameEventType.SHOT && type !== GameEventType.REBOUND
      )
    )(
      'accepts %s with no metadata and defaults it to {}',
      (eventType) => {
        const result = createGameEventSchema.safeParse({ eventType, playerId: PLAYER_ID });
        expect(result.success).toBe(true);
        expect(result.data?.metadata).toEqual({});
      }
    );

    it('accepts flat primitive metadata', () => {
      const result = createGameEventSchema.safeParse({
        eventType: 'TIMEOUT',
        metadata: { type: 'full', quarter: 2, note: null, official: true },
      });
      expect(result.success).toBe(true);
    });

    it('rejects nested metadata', () => {
      expect(
        createGameEventSchema.safeParse({ eventType: 'FOUL', metadata: { nested: { a: 1 } } }).success
      ).toBe(false);
    });
  });

  it.each([{}, { eventType: 'INVALID_TYPE' }])('rejects %p with Invalid event type', (body) => {
    expect(messages(body)).toContain('Invalid event type');
  });

  it('reports an invalid playerId alongside the metadata error', () => {
    expect(messages({ eventType: 'SHOT', playerId: 'not-a-uuid' })).toContain('Invalid player ID format');
  });
});
