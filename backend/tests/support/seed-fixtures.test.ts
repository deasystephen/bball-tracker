/**
 * Pins the seed's fixture data (#782, #787, #788).
 *
 * `prisma/seed.ts` is outside the `tsc` and ESLint scope and nothing runs it
 * in CI. This suite checks the pure data in `seed-fixtures.ts`: the seeded
 * event logs add up to the documented scores under the production scoring
 * rule, the seeded games are the five fixed ids, the managed-player ids are
 * real UUIDs. It reads the seed's source only to check that it imports the
 * shared resets; what those resets do is proven against Postgres in
 * `tests/integration/seed-resets.db.test.ts`.
 */

import fs from 'fs';
import path from 'path';
import { GameStatus } from '@prisma/client';
import { computeHomeScore } from '../../src/services/game-event-service';
import { INVITATION_RESEND_COOLDOWN_MS } from '../../src/services/invitation-service';
import { hashRecipient } from '../../src/utils/hash-recipient';
import {
  BRYCE_JAMES_ID,
  FINISHED_GAME_SCORES,
  SEED_IDS,
  SEEDED_GAME_IDS,
  SEEDED_LAKERS_MANAGED_IDS,
  invitationFixtureRow,
  inviteStateFixtures,
  lakersVsSunsEvents,
  seededGames,
  warriorsVsHeatEvents,
} from './seed-fixtures';

const SEED_SOURCE = fs.readFileSync(path.resolve(__dirname, '..', '..', 'prisma', 'seed.ts'), 'utf8');
const START = new Date('2026-01-01T18:00:00Z');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('seeded finished games', () => {
  const warriors = warriorsVsHeatEvents(
    SEED_IDS.WARRIORS_VS_HEAT_GAME,
    { steph: 'steph', klay: 'klay', draymond: 'draymond', wiggins: 'wiggins', poole: 'poole' },
    START
  );
  const lakers = lakersVsSunsEvents(
    SEED_IDS.LAKERS_VS_SUNS_GAME,
    { lebron: 'lebron', ad: 'ad', russ: 'russ', reaves: 'reaves', dlo: 'dlo' },
    START
  );

  it('Warriors vs Heat events add up to the documented home score', () => {
    expect(computeHomeScore(warriors)).toBe(FINISHED_GAME_SCORES.WARRIORS_VS_HEAT.home);
    expect(FINISHED_GAME_SCORES.WARRIORS_VS_HEAT.home).toBe(112);
  });

  it('Lakers vs Suns events add up to the documented home score', () => {
    expect(computeHomeScore(lakers)).toBe(FINISHED_GAME_SCORES.LAKERS_VS_SUNS.home);
    expect(FINISHED_GAME_SCORES.LAKERS_VS_SUNS.home).toBe(98);
  });

  it('per-player points match the stat lines in the builder comments', () => {
    const points = (events: typeof warriors, playerId: string): number =>
      computeHomeScore(events.filter((event) => event.playerId === playerId));
    expect(['steph', 'klay', 'draymond', 'wiggins', 'poole'].map((id) => points(warriors, id))).toEqual([
      32, 25, 12, 22, 21,
    ]);
    expect(['lebron', 'ad', 'russ', 'reaves', 'dlo'].map((id) => points(lakers, id))).toEqual([28, 24, 18, 15, 13]);
  });

  it('every event belongs to its game and happens after the start', () => {
    for (const [events, gameId] of [
      [warriors, SEED_IDS.WARRIORS_VS_HEAT_GAME],
      [lakers, SEED_IDS.LAKERS_VS_SUNS_GAME],
    ] as const) {
      expect(events.every((event) => event.gameId === gameId)).toBe(true);
      expect(events.every((event) => event.timestamp.getTime() > START.getTime())).toBe(true);
    }
  });
});

describe('seededGames', () => {
  const now = new Date('2026-06-01T12:00:00Z');
  const games = seededGames(now, { warriorsId: 'w', lakersId: 'l' });

  it('covers exactly the seeded game ids', () => {
    expect(games.map((game) => game.id).sort()).toEqual([...SEEDED_GAME_IDS].sort());
  });

  it('scheduled games are in the future with no score; finished ones carry the documented away scores', () => {
    for (const game of games) {
      if (game.status === GameStatus.SCHEDULED) {
        expect(game.date.getTime()).toBeGreaterThan(now.getTime());
        expect(game.awayScore).toBe(0);
      } else {
        expect(game.status).toBe(GameStatus.FINISHED);
        expect(game.date.getTime()).toBeLessThan(now.getTime());
      }
    }
    const byId = new Map(games.map((game) => [game.id, game]));
    expect(byId.get(SEED_IDS.WARRIORS_VS_HEAT_GAME)).toMatchObject({ awayScore: 105 });
    expect(byId.get(SEED_IDS.LAKERS_VS_SUNS_GAME)).toMatchObject({ awayScore: 102 });
    // No fixture carries a home score: it is derived from the events.
    expect(games.every((game) => !('homeScore' in game))).toBe(true);
  });
});

describe('seeded Lakers managed players (#782)', () => {
  it('are six fixed RFC 4122 UUIDs, Bryce James among them', () => {
    expect(SEEDED_LAKERS_MANAGED_IDS).toHaveLength(6);
    expect(new Set(SEEDED_LAKERS_MANAGED_IDS).size).toBe(6);
    expect(SEEDED_LAKERS_MANAGED_IDS.every((id) => UUID.test(id))).toBe(true);
    expect(SEEDED_LAKERS_MANAGED_IDS).toContain(BRYCE_JAMES_ID);
  });
});

/** Names the seed imports from a module, read from its import statements. */
function importedFrom(source: string, module: string): string[] {
  const escaped = module.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const match = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*'${escaped}'`).exec(source);
  return match ? match[1].split(',').map((name) => name.trim()).filter(Boolean) : [];
}

describe('prisma/seed.ts imports the shared resets (#782, #783, #787, #788)', () => {
  it('imports every reset from tests/support/seed-resets', () => {
    expect(importedFrom(SEED_SOURCE, '../tests/support/seed-resets')).toEqual(
      expect.arrayContaining([
        'ensureDefaultTeamRoles',
        'removeFlowCreatedManagedPlayers',
        'removeTombstones',
        'restoreSeededGames',
        'writeFinishedGameEvents',
      ])
    );
  });
});

describe('invite-state fixtures (#715 cooldown)', () => {
  const now = new Date('2026-10-05T00:00:00Z');
  const fixtures = inviteStateFixtures(now, { iris: 'iris', xander: 'xander', wendy: 'wendy' });

  it('dates every row older than the resend cooldown', () => {
    for (const f of fixtures) {
      expect(now.getTime() - f.createdAt.getTime()).toBeGreaterThan(INVITATION_RESEND_COOLDOWN_MS);
    }
  });

  it('keeps the chip states consistent with the dates', () => {
    const byName = Object.fromEntries(fixtures.map((f) => [f.name, f]));
    expect(byName['Iris Invited'].expiresAt.getTime()).toBeGreaterThan(now.getTime());
    expect(byName['Xander Expired'].expiresAt.getTime()).toBeLessThan(now.getTime());
    expect(byName['Xander Expired'].bounced).toBe(true);
    expect(byName['Wendy WebAccept'].acceptedAt!.getTime()).toBeGreaterThan(byName['Wendy WebAccept'].createdAt.getTime());
  });

  it('writes recipientHash the way the service does', () => {
    for (const f of fixtures) {
      const row = invitationFixtureRow(f);
      expect(row.recipientHash).toBe(hashRecipient(f.email));
      expect(row.createdAt).toBe(f.createdAt);
      expect('acceptedAt' in row).toBe(f.status === 'ACCEPTED');
    }
  });
});
