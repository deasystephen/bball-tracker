/**
 * Pins the seed's fixture data (#782, #787, #788).
 *
 * `prisma/seed.ts` is outside the `tsc` and ESLint scope and nothing runs it
 * in CI. This suite checks the pure data in `seed-fixtures.ts`: the seeded
 * event logs add up to the documented scores under the production scoring
 * rule, the seeded games are the five fixed ids, the managed-player ids are
 * real UUIDs, and the fixed Maestro invitation token is written only by a
 * local, opted-in, non-production seed run. It reads the seed's source only to check that it imports the
 * shared resets and the token rule; what those resets do is proven against Postgres in
 * `tests/integration/seed-resets.db.test.ts`.
 */

import fs from 'fs';
import path from 'path';
import { GameStatus } from '@prisma/client';
import { computeHomeScore } from '../../src/services/game-event-service';
import { INVITATION_RESEND_COOLDOWN_MS } from '../../src/utils/resend-cooldown';
import { hashRecipient } from '../../src/utils/hash-recipient';
import { isValidInvitationTokenFormat } from '../../src/utils/invitation-token';
import {
  BRYCE_JAMES_ID,
  FINISHED_GAME_SCORES,
  SEED_IDS,
  SEEDED_GAME_IDS,
  SEEDED_LAKERS_MANAGED_IDS,
  MAESTRO_INVITE_TOKEN,
  MAESTRO_INVITE_TOKEN_FLAG,
  invitationFixtureRow,
  invitationFixtureToken,
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

describe('the Maestro invitation token (#972, #973)', () => {
  const fixtures = inviteStateFixtures(new Date('2026-10-24T00:00:00Z'), {
    iris: 'iris',
    xander: 'xander',
    wendy: 'wendy',
  });
  const iris = fixtures.find((f) => f.name === 'Iris Invited')!;
  const random = (): string => 'random-token-for-this-run';
  const LOCAL_URL = 'postgresql://postgres:postgres@localhost:5432/bball_tracker?schema=public';
  const optedIn = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
    [MAESTRO_INVITE_TOKEN_FLAG]: 'true',
    DATABASE_URL: LOCAL_URL,
    ...env,
  });

  it('is a token the public by-token routes accept', () => {
    expect(isValidInvitationTokenFormat(MAESTRO_INVITE_TOKEN)).toBe(true);
  });

  it('belongs to the PENDING fixture only', () => {
    expect(fixtures.filter((f) => f.deepLinkToken)).toEqual([iris]);
    expect(iris.status).toBe('PENDING');
  });

  it.each([
    LOCAL_URL,
    'postgresql://postgres:postgres@127.0.0.1:5432/bball_tracker',
    'postgresql://postgres:postgres@postgres:5432/bball_tracker',
  ])('is written into a local database when the run opts in (%s)', (url) => {
    expect(invitationFixtureToken(iris, optedIn({ DATABASE_URL: url }), random)).toBe(MAESTRO_INVITE_TOKEN);
  });

  it.each<[string, NodeJS.ProcessEnv]>([
    ['without the opt-in', { DATABASE_URL: LOCAL_URL }],
    ['with the opt-in set to anything but true', { [MAESTRO_INVITE_TOKEN_FLAG]: '1', DATABASE_URL: LOCAL_URL }],
    ['with NODE_ENV=production (a tunnel on localhost)', optedIn({ NODE_ENV: 'production' })],
    ['with SEED_ALLOW_PRODUCTION=true', optedIn({ SEED_ALLOW_PRODUCTION: 'true' })],
    [
      'into an RDS host',
      optedIn({ DATABASE_URL: 'postgresql://app:secret@db.abc123.us-east-1.rds.amazonaws.com:5432/bball_tracker' }),
    ],
    ['into any other remote host', optedIn({ DATABASE_URL: 'postgresql://app:secret@db.example.org:5432/db' })],
    ['for an unparsable URL', optedIn({ DATABASE_URL: 'not a url' })],
    ['with no URL', { [MAESTRO_INVITE_TOKEN_FLAG]: 'true' }],
  ])('is never written %s', (_label, env) => {
    expect(invitationFixtureToken(iris, env, random)).toBe('random-token-for-this-run');
  });

  it('leaves every other fixture random, even when opted in locally', () => {
    for (const f of fixtures.filter((x) => x !== iris)) {
      expect(invitationFixtureToken(f, optedIn({}), random)).toBe('random-token-for-this-run');
    }
  });

  it('is what the seed writes and what the flow opens', () => {
    expect(SEED_SOURCE).toMatch(/token\s*=\s*invitationFixtureToken\(\s*fixture\s*,\s*process\.env\s*,/);
    const flow = fs.readFileSync(
      path.resolve(__dirname, '..', '..', '..', '.maestro', 'invite-deep-link.yaml'),
      'utf8'
    );
    expect(flow).toContain(`hooplings://invite/${MAESTRO_INVITE_TOKEN}?src=web`);
    expect(flow).toContain(`${MAESTRO_INVITE_TOKEN_FLAG}=true`);
  });
});
