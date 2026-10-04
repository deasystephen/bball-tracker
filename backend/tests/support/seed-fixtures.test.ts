/**
 * Pins the seed to service code (#787) and to its own fixture lists (#782, #788).
 *
 * `prisma/seed.ts` is outside the `tsc` and ESLint scope and nothing runs it
 * in CI, so a copy of service logic inside it drifts silently. It used to
 * carry its own `createDefaultTeamRoles` and hand-written `homeScore`
 * literals. This suite checks that the seeded event logs still add up to the
 * documented scores under the production scoring rule, and reads the seed's
 * source to check it calls the service functions instead of copying them.
 */

import fs from 'fs';
import path from 'path';
import { GameStatus } from '@prisma/client';
import { computeHomeScore } from '../../src/services/game-event-service';
import {
  BRYCE_JAMES_ID,
  FINISHED_GAME_SCORES,
  LAKERS_MANAGED_IDS,
  SEED_IDS,
  SEEDED_GAME_IDS,
  SEEDED_LAKERS_MANAGED_IDS,
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

  it('scheduled games are in the future with no score; finished ones carry the documented scores', () => {
    for (const game of games) {
      if (game.status === GameStatus.SCHEDULED) {
        expect(game.date.getTime()).toBeGreaterThan(now.getTime());
        expect([game.homeScore, game.awayScore]).toEqual([0, 0]);
      } else {
        expect(game.status).toBe(GameStatus.FINISHED);
        expect(game.date.getTime()).toBeLessThan(now.getTime());
      }
    }
    const byId = new Map(games.map((game) => [game.id, game]));
    expect(byId.get(SEED_IDS.WARRIORS_VS_HEAT_GAME)).toMatchObject({ homeScore: 112, awayScore: 105 });
    expect(byId.get(SEED_IDS.LAKERS_VS_SUNS_GAME)).toMatchObject({ homeScore: 98, awayScore: 102 });
  });
});

describe('seeded Lakers managed players (#782)', () => {
  it('are six fixed RFC 4122 UUIDs, Bryce James among them', () => {
    expect(SEEDED_LAKERS_MANAGED_IDS).toHaveLength(6);
    expect(new Set(SEEDED_LAKERS_MANAGED_IDS).size).toBe(6);
    expect(SEEDED_LAKERS_MANAGED_IDS.every((id) => UUID.test(id))).toBe(true);
    expect(SEEDED_LAKERS_MANAGED_IDS).toContain(BRYCE_JAMES_ID);
  });

  it('the seed creates them by these ids and excludes exactly this list from the reset', () => {
    for (const key of Object.keys(LAKERS_MANAGED_IDS)) {
      expect(SEED_SOURCE).toContain(`LAKERS_MANAGED_IDS.${key}`);
    }
    expect(SEED_SOURCE).toMatch(/id:\s*\{\s*notIn:\s*\[\.\.\.SEEDED_LAKERS_MANAGED_IDS\]\s*\}/);
    expect(SEED_SOURCE).not.toMatch(/NOT:\s*\{\s*id:\s*\{\s*startsWith:\s*'managed-'/);
  });
});

describe('prisma/seed.ts uses service code (#787)', () => {
  it('creates default team roles with the service function, not a local copy', () => {
    expect(SEED_SOURCE).toMatch(/import \{ createDefaultTeamRoles \} from '\.\.\/src\/utils\/permissions';/);
    expect(SEED_SOURCE).not.toMatch(/function createDefaultTeamRoles\s*\(/);
    expect(SEED_SOURCE).not.toMatch(/teamRole\.createMany/);
  });

  it('never writes a hand-picked home score', () => {
    expect(SEED_SOURCE).not.toMatch(/homeScore:\s*\d/);
    expect(SEED_SOURCE).toMatch(/writeFinishedGameEvents\(prisma, SEED_IDS\.WARRIORS_VS_HEAT_GAME/);
    expect(SEED_SOURCE).toMatch(/writeFinishedGameEvents\(prisma, SEED_IDS\.LAKERS_VS_SUNS_GAME/);
  });

  it('restores the seeded games and sweeps tombstones through the shared resets', () => {
    expect(SEED_SOURCE).toMatch(/restoreSeededGames\(prisma, games\)/);
    expect(SEED_SOURCE).toMatch(/removeTombstones\(prisma\)/);
    expect(SEED_SOURCE).not.toMatch(/user\.deleteMany\(\{\s*where:\s*\{\s*deletedAt/);
  });
});
