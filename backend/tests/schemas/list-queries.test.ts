/**
 * Schema tests for the list-query schemas of GET /games, GET /games/:gameId/events,
 * GET /invitations and GET /leagues (#693).
 *
 * The parsed `limit` and `offset` go straight to Prisma `take`/`skip`, so the
 * bounds here are the only cap on a page. Query-string values arrive as
 * strings, so every case is sent the way Express hands it over.
 */

import type { z } from 'zod';
import { gameEventQuerySchema, gameQuerySchema } from '../../src/api/games/schemas';
import { invitationQuerySchema } from '../../src/api/invitations/schemas';
import { leagueQuerySchema } from '../../src/api/leagues/schemas';

const VALID_UUID = '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

interface ListQueryCase {
  name: string;
  schema: z.ZodType;
  defaultLimit: number;
}

const LIST_QUERIES: ListQueryCase[] = [
  { name: 'gameQuerySchema', schema: gameQuerySchema, defaultLimit: 20 },
  { name: 'gameEventQuerySchema', schema: gameEventQuerySchema, defaultLimit: 50 },
  { name: 'invitationQuerySchema', schema: invitationQuerySchema, defaultLimit: 20 },
  { name: 'leagueQuerySchema', schema: leagueQuerySchema, defaultLimit: 20 },
];

describe.each(LIST_QUERIES)('$name pagination', ({ schema, defaultLimit }) => {
  it(`defaults to limit ${defaultLimit} and offset 0`, () => {
    const result = schema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.data).toEqual(expect.objectContaining({ limit: defaultLimit, offset: 0 }));
  });

  it('coerces valid pagination at the bounds', () => {
    expect(schema.safeParse({ limit: '1', offset: '0' }).data).toEqual(
      expect.objectContaining({ limit: 1, offset: 0 })
    );
    expect(schema.safeParse({ limit: '100', offset: '250' }).data).toEqual(
      expect.objectContaining({ limit: 100, offset: 250 })
    );
  });

  it.each([
    ['limit 0', { limit: '0' }],
    ['limit 101', { limit: '101' }],
    ['a non-numeric limit', { limit: 'abc' }],
    ['a fractional limit', { limit: '2.5' }],
    ['offset -1', { offset: '-1' }],
    ['a non-numeric offset', { offset: 'abc' }],
  ])('rejects %s', (_label, query) => {
    expect(schema.safeParse(query).success).toBe(false);
  });
});

describe('gameQuerySchema filters', () => {
  it('accepts a UUID teamId, a known status and ISO dates', () => {
    const result = gameQuerySchema.safeParse({
      teamId: VALID_UUID,
      status: 'SCHEDULED',
      startDate: '2026-10-01T00:00:00.000Z',
      endDate: '2026-10-31T23:59:59.000Z',
    });
    expect(result.success).toBe(true);
  });

  it.each([
    ['a non-UUID teamId', { teamId: 'team-1' }],
    ['an unknown status', { status: 'NOPE' }],
    ['a non-ISO startDate', { startDate: '10/01/2026' }],
    ['a date-only endDate', { endDate: '2026-10-31' }],
  ])('rejects %s', (_label, query) => {
    expect(gameQuerySchema.safeParse(query).success).toBe(false);
  });
});

describe('gameEventQuerySchema filters', () => {
  it('accepts a known eventType and a UUID playerId', () => {
    expect(gameEventQuerySchema.safeParse({ eventType: 'SHOT', playerId: VALID_UUID }).success).toBe(true);
  });

  it.each([
    ['an unknown eventType', { eventType: 'SHOT_MADE' }],
    ['a non-UUID playerId', { playerId: 'player-1' }],
  ])('rejects %s', (_label, query) => {
    expect(gameEventQuerySchema.safeParse(query).success).toBe(false);
  });
});

describe('invitationQuerySchema filters', () => {
  it.each([['PENDING'], ['ACCEPTED'], ['REJECTED'], ['EXPIRED'], ['CANCELLED']])(
    'accepts status %s',
    (status) => {
      expect(invitationQuerySchema.safeParse({ status }).success).toBe(true);
    }
  );

  it('accepts UUID teamId and playerId filters', () => {
    expect(invitationQuerySchema.safeParse({ teamId: VALID_UUID, playerId: VALID_UUID }).success).toBe(true);
  });

  it.each([
    ['an unknown status', { status: 'NOPE' }],
    ['a lower-case status', { status: 'pending' }],
    ['a non-UUID teamId', { teamId: 'team-1' }],
    ['a non-UUID playerId', { playerId: 'player-1' }],
  ])('rejects %s', (_label, query) => {
    expect(invitationQuerySchema.safeParse(query).success).toBe(false);
  });
});

describe('leagueQuerySchema filters', () => {
  // League ids are custom strings and the schema has no enum filter, so there
  // is no id or enum case here; `includePersonal` is the only typed filter.
  it("reads includePersonal 'true' as true", () => {
    expect(leagueQuerySchema.safeParse({ includePersonal: 'true' }).data?.includePersonal).toBe(true);
  });

  it("reads includePersonal 'false' as false", () => {
    expect(leagueQuerySchema.safeParse({ includePersonal: 'false' }).data?.includePersonal).toBe(false);
  });

  it.each([['1'], ['yes'], ['TRUE'], ['']])("rejects includePersonal '%s'", (value) => {
    expect(leagueQuerySchema.safeParse({ includePersonal: value }).success).toBe(false);
  });

  it('leaves includePersonal undefined when absent', () => {
    expect(leagueQuerySchema.safeParse({}).data?.includePersonal).toBeUndefined();
  });

  it('accepts a free-text search', () => {
    expect(leagueQuerySchema.safeParse({ search: 'Spring' }).data?.search).toBe('Spring');
  });
});
