/**
 * Unit tests for Socket.io game-events authorization + snapshot logic.
 *
 * We exercise `handleJoinGame` and `buildGameSnapshot` directly with a
 * lightweight fake socket — no real Socket.io server is started. The
 * integration test covers the full transport path.
 */

import {
  buildGameSnapshot,
  handleJoinGame,
  gameRoom,
  GAME_ROOM_PREFIX,
  resolveSocketUser,
  type GameSocket,
} from '../../src/websocket/game-events';
import { mockPrisma } from '../setup';
import {
  createGame,
  createTeam,
  createSeason,
  createLeague,
  createPlayer,
  createCoach,
  createTeamMember,
  createTeamRole,
  createTeamStaff,
  createGameEvent,
} from '../factories';

interface FakeSocket {
  id: string;
  joined: string[];
  emitted: Array<{ event: string; payload: unknown }>;
  data: { user: { id: string; email: string | null; name: string; role: string } };
  join: jest.Mock;
  emit: jest.Mock;
}

function makeFakeSocket(userId: string): FakeSocket {
  const joined: string[] = [];
  const emitted: Array<{ event: string; payload: unknown }> = [];
  return {
    id: 'sock-1',
    joined,
    emitted,
    data: { user: { id: userId, email: null, name: 'Tester', role: 'USER' } },
    join: jest.fn((room: string) => {
      joined.push(room);
      return Promise.resolve();
    }),
    emit: jest.fn((event: string, payload: unknown) => {
      emitted.push({ event, payload });
      return true;
    }),
  };
}

describe('websocket/game-events', () => {
  describe('gameRoom', () => {
    it('prefixes the game id with the canonical room prefix', () => {
      expect(gameRoom('abc')).toBe(`${GAME_ROOM_PREFIX}abc`);
    });
  });

  describe('handleJoinGame', () => {
    it('rejects with bad_request when payload omits gameId', async () => {
      const socket = makeFakeSocket('user-1');
      const result = await handleJoinGame(socket as unknown as GameSocket, {});
      expect(result).toEqual({
        ok: false,
        code: 'bad_request',
        message: 'gameId is required',
      });
      expect(socket.join).not.toHaveBeenCalled();
    });

    it('rejects with not_found when the game does not exist', async () => {
      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue(null);
      const socket = makeFakeSocket('user-1');

      const result = await handleJoinGame(socket as unknown as GameSocket, { gameId: 'nope' });

      expect(result).toEqual({
        ok: false,
        code: 'not_found',
        message: 'Game not found',
      });
    });

    it('rejects with forbidden when the user cannot access the team', async () => {
      const outsider = createPlayer();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const game = createGame({ teamId: team.id });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
        id: game.id,
        teamId: team.id,
      });
      // canAccessTeam: not admin, not staff, not a member
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(outsider);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { ...season, league: { ...league, admins: [] } },
      });
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);

      const socket = makeFakeSocket(outsider.id);
      const result = await handleJoinGame(socket as unknown as GameSocket, { gameId: game.id });

      expect(result).toEqual({
        ok: false,
        code: 'forbidden',
        message: 'You do not have access to this game',
      });
      expect(socket.join).not.toHaveBeenCalled();
    });

    it('joins the game room and emits a snapshot when the user has access', async () => {
      const coach = createCoach();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
      const coachStaff = createTeamStaff({
        teamId: team.id,
        userId: coach.id,
        roleId: headCoachRole.id,
      });
      const player = createPlayer();
      createTeamMember({ teamId: team.id, playerId: player.id });
      const game = createGame({
        teamId: team.id,
        status: 'IN_PROGRESS',
        homeScore: 12,
        awayScore: 9,
      });
      const event = createGameEvent({
        gameId: game.id,
        playerId: player.id,
        eventType: 'SHOT',
      });

      // handleJoinGame does two prisma.game.findUnique calls:
      //  1) select { id, teamId } for authorization
      //  2) include events for the snapshot
      (mockPrisma.game.findUnique as jest.Mock)
        .mockResolvedValueOnce({ id: game.id, teamId: team.id })
        .mockResolvedValueOnce({
          ...game,
          events: [{ ...event, player: { id: player.id, name: player.name } }],
        });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { ...season, league: { ...league, admins: [] } },
      });
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(coachStaff);

      const socket = makeFakeSocket(coach.id);
      const result = await handleJoinGame(socket as unknown as GameSocket, { gameId: game.id });

      expect(result).toEqual({ ok: true, gameId: game.id });
      expect(socket.join).toHaveBeenCalledWith(gameRoom(game.id));
      expect(socket.emitted).toHaveLength(1);
      expect(socket.emitted[0].event).toBe('game-snapshot');
      const payload = socket.emitted[0].payload as {
        game: { id: string; status: string; homeScore: number; awayScore: number };
        events: Array<{ id: string }>;
      };
      expect(payload.game.id).toBe(game.id);
      expect(payload.game.status).toBe('IN_PROGRESS');
      expect(payload.game.homeScore).toBe(12);
      expect(payload.events).toHaveLength(1);
    });
  });

  describe('buildGameSnapshot', () => {
    it('returns null when the game does not exist', async () => {
      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue(null);
      const snapshot = await buildGameSnapshot('missing');
      expect(snapshot).toBeNull();
    });

    it('returns events in chronological order', async () => {
      const game = createGame();
      const older = createGameEvent({ gameId: game.id, eventType: 'SHOT' });
      const newer = createGameEvent({ gameId: game.id, eventType: 'REBOUND' });
      // Prisma returns desc (newest first); buildGameSnapshot reverses.
      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
        ...game,
        events: [newer, older],
      });

      const snapshot = await buildGameSnapshot(game.id);
      expect(snapshot).not.toBeNull();
      expect(snapshot?.events.map((e) => e.id)).toEqual([older.id, newer.id]);
    });
  });

  describe('resolveSocketUser', () => {
    it('returns null when the token is missing', async () => {
      expect(await resolveSocketUser(undefined)).toBeNull();
      expect(await resolveSocketUser('')).toBeNull();
    });

    it('returns null when a dev token is expired', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';
      try {
        const expired = Buffer.from(
          JSON.stringify({ userId: 'u1', exp: Date.now() - 1000 })
        ).toString('base64');
        expect(await resolveSocketUser(`dev_${expired}`)).toBeNull();
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });

    it('resolves a valid dev token to the corresponding user', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';
      try {
        const user = createCoach();
        const valid = Buffer.from(
          JSON.stringify({ userId: user.id, exp: Date.now() + 60_000 })
        ).toString('base64');
        (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
        });

        const resolved = await resolveSocketUser(`Bearer dev_${valid}`);
        expect(resolved).toEqual({
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
        });
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });
  });
});
