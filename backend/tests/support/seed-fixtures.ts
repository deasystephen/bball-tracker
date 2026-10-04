/**
 * The seed's fixed fixtures, importable without running the seed (#782, #787, #788).
 *
 * `backend/prisma/seed.ts` is the reset between Maestro flows. It sits outside
 * the `tsc` and ESLint scope and no test runs it, so the parts of it that must
 * agree with service code or with each other live here, where
 * `tests/support/seed-fixtures.test.ts` can pin them:
 *
 * - the fixed ids of the seeded Lakers managed players, which the reset that
 *   removes flow-created managed players must leave alone (#782);
 * - the event logs of the two FINISHED games and the scores they add up to
 *   under `GameEventService.computeHomeScore` (#787);
 * - the five seeded games and the state every reseed puts them back in (#788).
 *
 * Pure data and builders only: nothing here touches a database
 * (`seed-resets.ts` does).
 */

import { GameEventType, GameStatus } from '@prisma/client';

/** Deterministic UUIDs for seed data (reproducible across runs). */
export const SEED_IDS = {
  LEAGUE: '10000000-0000-4000-a000-000000000001',
  WARRIORS_TEAM: '20000000-0000-4000-a000-000000000001',
  LAKERS_TEAM: '20000000-0000-4000-a000-000000000002',
  // Persistent identities (#462). Fixed ids so re-runs are idempotent; an
  // existing dev DB keeps the lineage the migration backfilled plus this one.
  WARRIORS_LINEAGE: '21000000-0000-4000-a000-000000000001',
  LAKERS_LINEAGE: '21000000-0000-4000-a000-000000000002',
  WARRIORS_VS_LAKERS_GAME: '30000000-0000-4000-a000-000000000001',
  WARRIORS_VS_CELTICS_GAME: '30000000-0000-4000-a000-000000000002',
  WARRIORS_VS_HEAT_GAME: '30000000-0000-4000-a000-000000000003',
  LAKERS_VS_WARRIORS_GAME: '30000000-0000-4000-a000-000000000004',
  LAKERS_VS_SUNS_GAME: '30000000-0000-4000-a000-000000000005',
} as const;

/** #444 guardian child-deletion fixture (managed Lakers player, Gloria as guardian). */
export const BRYCE_JAMES_ID = '40000000-0000-4000-a000-000000000109';

/**
 * Coach Frank Vogel's seeded Lakers managed players. Real UUIDs: the API
 * validates every player id with `z.string().uuid()`.
 */
export const LAKERS_MANAGED_IDS = {
  MARCUS_JOHNSON: '40000000-0000-4000-a000-000000000107',
  ETHAN_WILLIAMS: '40000000-0000-4000-a000-000000000114',
  BRYCE_JAMES: BRYCE_JAMES_ID,
  // Invite-state fixtures (one per roster chip state).
  IRIS_INVITED: '40000000-0000-4000-a000-000000000221',
  XANDER_EXPIRED: '40000000-0000-4000-a000-000000000222',
  WENDY_WEBACCEPT: '40000000-0000-4000-a000-000000000224',
} as const;

/**
 * Every managed player the seed itself creates for Frank. The reset that
 * removes the managed players roster flows add to his Lakers excludes exactly
 * these (#782); a new seeded Lakers managed player must be added here.
 */
export const SEEDED_LAKERS_MANAGED_IDS: readonly string[] = Object.values(LAKERS_MANAGED_IDS);

/** The five seeded games. Each reseed restores them (`seed-resets.ts#restoreSeededGames`). */
export const SEEDED_GAME_IDS: readonly string[] = [
  SEED_IDS.WARRIORS_VS_LAKERS_GAME,
  SEED_IDS.WARRIORS_VS_CELTICS_GAME,
  SEED_IDS.WARRIORS_VS_HEAT_GAME,
  SEED_IDS.LAKERS_VS_WARRIORS_GAME,
  SEED_IDS.LAKERS_VS_SUNS_GAME,
];

/**
 * Final scores of the two FINISHED games, as `docs/testing/workos-test-accounts.md`
 * documents them. `home` is NOT written from here: the seed derives
 * `Game.homeScore` from the events with `computeHomeScore`, and
 * `seed-fixtures.test.ts` fails if the events stop adding up to it. `away` has
 * no event source (the coach enters it), so it is written as is.
 */
export const FINISHED_GAME_SCORES = {
  WARRIORS_VS_HEAT: { home: 112, away: 105 },
  LAKERS_VS_SUNS: { home: 98, away: 102 },
} as const;

/** A seeded game and the state every reseed puts it back in. */
export interface SeededGame {
  id: string;
  teamId: string;
  opponent: string;
  date: Date;
  status: GameStatus;
  /** 0 for a SCHEDULED game; a FINISHED game's score is re-derived from its events. */
  homeScore: number;
  awayScore: number;
  /** For the seed's log line. */
  label: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The five seeded games relative to `now`. Dates move with every reseed, so a
 * "tomorrow" game is tomorrow again after the reset.
 */
export function seededGames(now: Date, teams: { warriorsId: string; lakersId: string }): SeededGame[] {
  const tomorrow = new Date(now.getTime() + DAY_MS);
  const nextWeek = new Date(now.getTime() + 7 * DAY_MS);
  const lastWeek = new Date(now.getTime() - 7 * DAY_MS);
  const heat = FINISHED_GAME_SCORES.WARRIORS_VS_HEAT;
  const suns = FINISHED_GAME_SCORES.LAKERS_VS_SUNS;
  return [
    {
      id: SEED_IDS.WARRIORS_VS_LAKERS_GAME,
      teamId: teams.warriorsId,
      opponent: 'Lakers',
      date: tomorrow,
      status: GameStatus.SCHEDULED,
      homeScore: 0,
      awayScore: 0,
      label: 'Warriors vs Lakers (Scheduled - tomorrow)',
    },
    {
      id: SEED_IDS.WARRIORS_VS_CELTICS_GAME,
      teamId: teams.warriorsId,
      opponent: 'Celtics',
      date: nextWeek,
      status: GameStatus.SCHEDULED,
      homeScore: 0,
      awayScore: 0,
      label: 'Warriors vs Celtics (Scheduled - next week)',
    },
    {
      id: SEED_IDS.WARRIORS_VS_HEAT_GAME,
      teamId: teams.warriorsId,
      opponent: 'Heat',
      date: lastWeek,
      status: GameStatus.FINISHED,
      homeScore: heat.home,
      awayScore: heat.away,
      label: `Warriors vs Heat (Finished - ${heat.home}-${heat.away})`,
    },
    {
      id: SEED_IDS.LAKERS_VS_WARRIORS_GAME,
      teamId: teams.lakersId,
      opponent: 'Warriors',
      date: tomorrow,
      status: GameStatus.SCHEDULED,
      homeScore: 0,
      awayScore: 0,
      label: 'Lakers vs Warriors (Scheduled - tomorrow)',
    },
    {
      id: SEED_IDS.LAKERS_VS_SUNS_GAME,
      teamId: teams.lakersId,
      opponent: 'Suns',
      date: lastWeek,
      status: GameStatus.FINISHED,
      homeScore: suns.home,
      awayScore: suns.away,
      label: `Lakers vs Suns (Finished - ${suns.home}-${suns.away})`,
    },
  ];
}

/** One `GameEvent` row as the seed writes it. */
export interface SeedEvent {
  gameId: string;
  playerId: string;
  eventType: GameEventType;
  timestamp: Date;
  metadata: { made: boolean; points: number } | { type: 'offensive' | 'defensive' } | Record<string, never>;
}

function createShotEvent(gameId: string, playerId: string, made: boolean, points: number, timestamp: Date): SeedEvent {
  return { gameId, playerId, eventType: GameEventType.SHOT, timestamp, metadata: { made, points } };
}

function createReboundEvent(
  gameId: string,
  playerId: string,
  type: 'offensive' | 'defensive',
  timestamp: Date
): SeedEvent {
  return { gameId, playerId, eventType: GameEventType.REBOUND, timestamp, metadata: { type } };
}

function createSimpleEvent(gameId: string, playerId: string, eventType: GameEventType, timestamp: Date): SeedEvent {
  return { gameId, playerId, eventType, timestamp, metadata: {} };
}

/**
 * Warriors vs Heat (112-105), Warriors stat lines:
 *
 *     Steph Curry: 32 pts (10-18 FG, 6-12 3PT, 6-6 FT), 5 reb, 8 ast, 2 stl, 0 blk, 3 TO, 2 fouls
 *     Klay Thompson: 25 pts (9-17 FG, 5-10 3PT, 2-2 FT), 4 reb, 2 ast, 1 stl, 0 blk, 1 TO, 3 fouls
 *     Draymond Green: 12 pts (5-9 FG, 1-3 3PT, 1-2 FT), 10 reb, 7 ast, 2 stl, 2 blk, 4 TO, 4 fouls
 *     Andrew Wiggins: 22 pts (8-14 FG, 2-5 3PT, 4-5 FT), 6 reb, 2 ast, 1 stl, 1 blk, 2 TO, 2 fouls
 *     Jordan Poole: 21 pts (7-15 FG, 3-8 3PT, 4-4 FT), 3 reb, 4 ast, 0 stl, 0 blk, 2 TO, 3 fouls
 */
export function warriorsVsHeatEvents(
  warriorsGameId: string,
  ids: { steph: string; klay: string; draymond: string; wiggins: string; poole: string },
  start: Date
): SeedEvent[] {
  const stephId = ids.steph;
  const klayId = ids.klay;
  const draymondId = ids.draymond;
  const wigginsId = ids.wiggins;
  const pooleId = ids.poole;
  const warriorsEvents: SeedEvent[] = [];
  let eventTime = new Date(start);

  // Steph Curry events
  // 2-pointers: 4 made, 2 missed (4*2=8 pts from 2s)
  for (let i = 0; i < 4; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createShotEvent(warriorsGameId, stephId, true, 2, eventTime));
  }
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createShotEvent(warriorsGameId, stephId, false, 2, eventTime));
  }
  // 3-pointers: 6 made, 6 missed (6*3=18 pts from 3s)
  for (let i = 0; i < 6; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createShotEvent(warriorsGameId, stephId, true, 3, eventTime));
  }
  for (let i = 0; i < 6; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createShotEvent(warriorsGameId, stephId, false, 3, eventTime));
  }
  // Free throws: 6 made (6 pts)
  for (let i = 0; i < 6; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createShotEvent(warriorsGameId, stephId, true, 1, eventTime));
  }
  // Rebounds: 3 def, 2 off
  for (let i = 0; i < 3; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createReboundEvent(warriorsGameId, stephId, 'defensive', eventTime));
  }
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createReboundEvent(warriorsGameId, stephId, 'offensive', eventTime));
  }
  // Assists: 8
  for (let i = 0; i < 8; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createSimpleEvent(warriorsGameId, stephId, GameEventType.ASSIST, eventTime));
  }
  // Steals: 2
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createSimpleEvent(warriorsGameId, stephId, GameEventType.STEAL, eventTime));
  }
  // Turnovers: 3
  for (let i = 0; i < 3; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createSimpleEvent(warriorsGameId, stephId, GameEventType.TURNOVER, eventTime));
  }
  // Fouls: 2
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createSimpleEvent(warriorsGameId, stephId, GameEventType.FOUL, eventTime));
  }

  // Klay Thompson events - 25 pts (4 2PT made, 3 missed, 5 3PT made, 5 missed, 2 FT made)
  for (let i = 0; i < 4; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createShotEvent(warriorsGameId, klayId, true, 2, eventTime));
  }
  for (let i = 0; i < 3; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createShotEvent(warriorsGameId, klayId, false, 2, eventTime));
  }
  for (let i = 0; i < 5; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createShotEvent(warriorsGameId, klayId, true, 3, eventTime));
  }
  for (let i = 0; i < 5; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createShotEvent(warriorsGameId, klayId, false, 3, eventTime));
  }
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createShotEvent(warriorsGameId, klayId, true, 1, eventTime));
  }
  // 4 rebounds, 2 assists, 1 steal, 1 TO, 3 fouls
  for (let i = 0; i < 4; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createReboundEvent(warriorsGameId, klayId, 'defensive', eventTime));
  }
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createSimpleEvent(warriorsGameId, klayId, GameEventType.ASSIST, eventTime));
  }
  warriorsEvents.push(createSimpleEvent(warriorsGameId, klayId, GameEventType.STEAL, new Date(eventTime.getTime() + 60000)));
  warriorsEvents.push(createSimpleEvent(warriorsGameId, klayId, GameEventType.TURNOVER, new Date(eventTime.getTime() + 120000)));
  for (let i = 0; i < 3; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createSimpleEvent(warriorsGameId, klayId, GameEventType.FOUL, eventTime));
  }

  // Draymond Green events - 12 pts (4 2PT made, 2 missed, 1 3PT made, 2 missed, 1 FT made, 1 missed)
  for (let i = 0; i < 4; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createShotEvent(warriorsGameId, draymondId, true, 2, eventTime));
  }
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createShotEvent(warriorsGameId, draymondId, false, 2, eventTime));
  }
  warriorsEvents.push(createShotEvent(warriorsGameId, draymondId, true, 3, new Date(eventTime.getTime() + 60000)));
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createShotEvent(warriorsGameId, draymondId, false, 3, eventTime));
  }
  warriorsEvents.push(createShotEvent(warriorsGameId, draymondId, true, 1, new Date(eventTime.getTime() + 60000)));
  warriorsEvents.push(createShotEvent(warriorsGameId, draymondId, false, 1, new Date(eventTime.getTime() + 120000)));
  // 10 rebounds (7 def, 3 off), 7 assists, 2 steals, 2 blocks, 4 TO, 4 fouls
  for (let i = 0; i < 7; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createReboundEvent(warriorsGameId, draymondId, 'defensive', eventTime));
  }
  for (let i = 0; i < 3; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createReboundEvent(warriorsGameId, draymondId, 'offensive', eventTime));
  }
  for (let i = 0; i < 7; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createSimpleEvent(warriorsGameId, draymondId, GameEventType.ASSIST, eventTime));
  }
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createSimpleEvent(warriorsGameId, draymondId, GameEventType.STEAL, eventTime));
  }
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createSimpleEvent(warriorsGameId, draymondId, GameEventType.BLOCK, eventTime));
  }
  for (let i = 0; i < 4; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createSimpleEvent(warriorsGameId, draymondId, GameEventType.TURNOVER, eventTime));
  }
  for (let i = 0; i < 4; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createSimpleEvent(warriorsGameId, draymondId, GameEventType.FOUL, eventTime));
  }

  // Andrew Wiggins events - 22 pts (6 2PT made, 3 missed, 2 3PT made, 3 missed, 4 FT made, 1 missed)
  for (let i = 0; i < 6; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createShotEvent(warriorsGameId, wigginsId, true, 2, eventTime));
  }
  for (let i = 0; i < 3; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createShotEvent(warriorsGameId, wigginsId, false, 2, eventTime));
  }
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createShotEvent(warriorsGameId, wigginsId, true, 3, eventTime));
  }
  for (let i = 0; i < 3; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createShotEvent(warriorsGameId, wigginsId, false, 3, eventTime));
  }
  for (let i = 0; i < 4; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createShotEvent(warriorsGameId, wigginsId, true, 1, eventTime));
  }
  warriorsEvents.push(createShotEvent(warriorsGameId, wigginsId, false, 1, new Date(eventTime.getTime() + 60000)));
  // 6 rebounds, 2 assists, 1 steal, 1 block, 2 TO, 2 fouls
  for (let i = 0; i < 4; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createReboundEvent(warriorsGameId, wigginsId, 'defensive', eventTime));
  }
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createReboundEvent(warriorsGameId, wigginsId, 'offensive', eventTime));
  }
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createSimpleEvent(warriorsGameId, wigginsId, GameEventType.ASSIST, eventTime));
  }
  warriorsEvents.push(createSimpleEvent(warriorsGameId, wigginsId, GameEventType.STEAL, new Date(eventTime.getTime() + 60000)));
  warriorsEvents.push(createSimpleEvent(warriorsGameId, wigginsId, GameEventType.BLOCK, new Date(eventTime.getTime() + 120000)));
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createSimpleEvent(warriorsGameId, wigginsId, GameEventType.TURNOVER, eventTime));
  }
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createSimpleEvent(warriorsGameId, wigginsId, GameEventType.FOUL, eventTime));
  }

  // Jordan Poole events - 21 pts (4 2PT made, 4 missed, 3 3PT made, 5 missed, 4 FT made)
  for (let i = 0; i < 4; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createShotEvent(warriorsGameId, pooleId, true, 2, eventTime));
  }
  for (let i = 0; i < 4; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createShotEvent(warriorsGameId, pooleId, false, 2, eventTime));
  }
  for (let i = 0; i < 3; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createShotEvent(warriorsGameId, pooleId, true, 3, eventTime));
  }
  for (let i = 0; i < 5; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createShotEvent(warriorsGameId, pooleId, false, 3, eventTime));
  }
  for (let i = 0; i < 4; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createShotEvent(warriorsGameId, pooleId, true, 1, eventTime));
  }
  // 3 rebounds, 4 assists, 0 steals, 0 blocks, 2 TO, 3 fouls
  for (let i = 0; i < 3; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createReboundEvent(warriorsGameId, pooleId, 'defensive', eventTime));
  }
  for (let i = 0; i < 4; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createSimpleEvent(warriorsGameId, pooleId, GameEventType.ASSIST, eventTime));
  }
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createSimpleEvent(warriorsGameId, pooleId, GameEventType.TURNOVER, eventTime));
  }
  for (let i = 0; i < 3; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createSimpleEvent(warriorsGameId, pooleId, GameEventType.FOUL, eventTime));
  }

  return warriorsEvents;
}

/**
 * Lakers vs Suns (98-102), Lakers stat lines:
 *
 *     LeBron James: 28 pts (10-19 FG, 2-6 3PT, 6-8 FT), 8 reb, 9 ast, 1 stl, 1 blk, 4 TO, 2 fouls
 *     Anthony Davis: 24 pts (9-16 FG, 0-1 3PT, 6-7 FT), 12 reb, 3 ast, 1 stl, 3 blk, 2 TO, 4 fouls
 *     Russell Westbrook: 18 pts (7-15 FG, 1-4 3PT, 3-5 FT), 6 reb, 7 ast, 2 stl, 0 blk, 5 TO, 3 fouls
 *     Austin Reaves: 15 pts (5-10 FG, 3-6 3PT, 2-2 FT), 3 reb, 4 ast, 1 stl, 0 blk, 1 TO, 2 fouls
 *     D'Angelo Russell: 13 pts (4-12 FG, 3-7 3PT, 2-2 FT), 2 reb, 5 ast, 0 stl, 0 blk, 2 TO, 1 foul
 */
export function lakersVsSunsEvents(
  lakersGameId: string,
  ids: { lebron: string; ad: string; russ: string; reaves: string; dlo: string },
  start: Date
): SeedEvent[] {
  const lebronId = ids.lebron;
  const adId = ids.ad;
  const russId = ids.russ;
  const reavesId = ids.reaves;
  const dloId = ids.dlo;
  const lakersEvents: SeedEvent[] = [];
  let eventTime = new Date(start);

  // LeBron James events - 28 pts (8 2PT made, 5 missed, 2 3PT made, 4 missed, 6 FT made, 2 missed)
  for (let i = 0; i < 8; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createShotEvent(lakersGameId, lebronId, true, 2, eventTime));
  }
  for (let i = 0; i < 5; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createShotEvent(lakersGameId, lebronId, false, 2, eventTime));
  }
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createShotEvent(lakersGameId, lebronId, true, 3, eventTime));
  }
  for (let i = 0; i < 4; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createShotEvent(lakersGameId, lebronId, false, 3, eventTime));
  }
  for (let i = 0; i < 6; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createShotEvent(lakersGameId, lebronId, true, 1, eventTime));
  }
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createShotEvent(lakersGameId, lebronId, false, 1, eventTime));
  }
  // 8 rebounds (6 def, 2 off), 9 assists, 1 steal, 1 block, 4 TO, 2 fouls
  for (let i = 0; i < 6; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createReboundEvent(lakersGameId, lebronId, 'defensive', eventTime));
  }
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createReboundEvent(lakersGameId, lebronId, 'offensive', eventTime));
  }
  for (let i = 0; i < 9; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createSimpleEvent(lakersGameId, lebronId, GameEventType.ASSIST, eventTime));
  }
  lakersEvents.push(createSimpleEvent(lakersGameId, lebronId, GameEventType.STEAL, new Date(eventTime.getTime() + 60000)));
  lakersEvents.push(createSimpleEvent(lakersGameId, lebronId, GameEventType.BLOCK, new Date(eventTime.getTime() + 120000)));
  for (let i = 0; i < 4; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createSimpleEvent(lakersGameId, lebronId, GameEventType.TURNOVER, eventTime));
  }
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createSimpleEvent(lakersGameId, lebronId, GameEventType.FOUL, eventTime));
  }

  // Anthony Davis events - 24 pts (9 2PT made, 6 missed, 0 3PT made, 1 missed, 6 FT made, 1 missed)
  for (let i = 0; i < 9; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createShotEvent(lakersGameId, adId, true, 2, eventTime));
  }
  for (let i = 0; i < 6; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createShotEvent(lakersGameId, adId, false, 2, eventTime));
  }
  lakersEvents.push(createShotEvent(lakersGameId, adId, false, 3, new Date(eventTime.getTime() + 60000)));
  for (let i = 0; i < 6; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createShotEvent(lakersGameId, adId, true, 1, eventTime));
  }
  lakersEvents.push(createShotEvent(lakersGameId, adId, false, 1, new Date(eventTime.getTime() + 60000)));
  // 12 rebounds (8 def, 4 off), 3 assists, 1 steal, 3 blocks, 2 TO, 4 fouls
  for (let i = 0; i < 8; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createReboundEvent(lakersGameId, adId, 'defensive', eventTime));
  }
  for (let i = 0; i < 4; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createReboundEvent(lakersGameId, adId, 'offensive', eventTime));
  }
  for (let i = 0; i < 3; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createSimpleEvent(lakersGameId, adId, GameEventType.ASSIST, eventTime));
  }
  lakersEvents.push(createSimpleEvent(lakersGameId, adId, GameEventType.STEAL, new Date(eventTime.getTime() + 60000)));
  for (let i = 0; i < 3; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createSimpleEvent(lakersGameId, adId, GameEventType.BLOCK, eventTime));
  }
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createSimpleEvent(lakersGameId, adId, GameEventType.TURNOVER, eventTime));
  }
  for (let i = 0; i < 4; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createSimpleEvent(lakersGameId, adId, GameEventType.FOUL, eventTime));
  }

  // Russell Westbrook events - 18 pts (6 2PT made, 7 missed, 1 3PT made, 3 missed, 3 FT made, 2 missed)
  for (let i = 0; i < 6; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createShotEvent(lakersGameId, russId, true, 2, eventTime));
  }
  for (let i = 0; i < 7; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createShotEvent(lakersGameId, russId, false, 2, eventTime));
  }
  lakersEvents.push(createShotEvent(lakersGameId, russId, true, 3, new Date(eventTime.getTime() + 60000)));
  for (let i = 0; i < 3; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createShotEvent(lakersGameId, russId, false, 3, eventTime));
  }
  for (let i = 0; i < 3; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createShotEvent(lakersGameId, russId, true, 1, eventTime));
  }
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createShotEvent(lakersGameId, russId, false, 1, eventTime));
  }
  // 6 rebounds, 7 assists, 2 steals, 0 blocks, 5 TO, 3 fouls
  for (let i = 0; i < 5; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createReboundEvent(lakersGameId, russId, 'defensive', eventTime));
  }
  lakersEvents.push(createReboundEvent(lakersGameId, russId, 'offensive', new Date(eventTime.getTime() + 60000)));
  for (let i = 0; i < 7; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createSimpleEvent(lakersGameId, russId, GameEventType.ASSIST, eventTime));
  }
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createSimpleEvent(lakersGameId, russId, GameEventType.STEAL, eventTime));
  }
  for (let i = 0; i < 5; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createSimpleEvent(lakersGameId, russId, GameEventType.TURNOVER, eventTime));
  }
  for (let i = 0; i < 3; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createSimpleEvent(lakersGameId, russId, GameEventType.FOUL, eventTime));
  }

  // Austin Reaves events - 15 pts (2 2PT made, 2 missed, 3 3PT made, 3 missed, 2 FT made)
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createShotEvent(lakersGameId, reavesId, true, 2, eventTime));
  }
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createShotEvent(lakersGameId, reavesId, false, 2, eventTime));
  }
  for (let i = 0; i < 3; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createShotEvent(lakersGameId, reavesId, true, 3, eventTime));
  }
  for (let i = 0; i < 3; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createShotEvent(lakersGameId, reavesId, false, 3, eventTime));
  }
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createShotEvent(lakersGameId, reavesId, true, 1, eventTime));
  }
  // 3 rebounds, 4 assists, 1 steal, 0 blocks, 1 TO, 2 fouls
  for (let i = 0; i < 3; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createReboundEvent(lakersGameId, reavesId, 'defensive', eventTime));
  }
  for (let i = 0; i < 4; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createSimpleEvent(lakersGameId, reavesId, GameEventType.ASSIST, eventTime));
  }
  lakersEvents.push(createSimpleEvent(lakersGameId, reavesId, GameEventType.STEAL, new Date(eventTime.getTime() + 60000)));
  lakersEvents.push(createSimpleEvent(lakersGameId, reavesId, GameEventType.TURNOVER, new Date(eventTime.getTime() + 120000)));
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createSimpleEvent(lakersGameId, reavesId, GameEventType.FOUL, eventTime));
  }

  // D'Angelo Russell events - 13 pts (1 2PT made, 3 missed, 3 3PT made, 4 missed, 2 FT made)
  lakersEvents.push(createShotEvent(lakersGameId, dloId, true, 2, new Date(eventTime.getTime() + 60000)));
  for (let i = 0; i < 3; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createShotEvent(lakersGameId, dloId, false, 2, eventTime));
  }
  for (let i = 0; i < 3; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createShotEvent(lakersGameId, dloId, true, 3, eventTime));
  }
  for (let i = 0; i < 4; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createShotEvent(lakersGameId, dloId, false, 3, eventTime));
  }
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createShotEvent(lakersGameId, dloId, true, 1, eventTime));
  }
  // 2 rebounds, 5 assists, 0 steals, 0 blocks, 2 TO, 1 foul
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createReboundEvent(lakersGameId, dloId, 'defensive', eventTime));
  }
  for (let i = 0; i < 5; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createSimpleEvent(lakersGameId, dloId, GameEventType.ASSIST, eventTime));
  }
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createSimpleEvent(lakersGameId, dloId, GameEventType.TURNOVER, eventTime));
  }
  lakersEvents.push(createSimpleEvent(lakersGameId, dloId, GameEventType.FOUL, new Date(eventTime.getTime() + 60000)));

  return lakersEvents;
}
