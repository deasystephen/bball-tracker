/**
 * Integration test: connect → join → receive snapshot → receive event.
 *
 * Spins up a real Socket.io server bound to an ephemeral port, registers the
 * production handlers, and uses socket.io-client to drive the full transport
 * path. Prisma is still mocked via `tests/setup.ts` so we exercise the room
 * + authorization wiring without a database.
 */

import { createServer, type Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import { Server as SocketServer } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';

import { setupWebSocketHandlers, emitGameEvent } from '../../src/websocket';
import { setIo } from '../../src/websocket/io-registry';
import { mockPrisma } from '../setup';
import {
  createCoach,
  createTeam,
  createSeason,
  createLeague,
  createGame,
  createGameEvent,
  createTeamRole,
  createTeamStaff,
} from '../factories';

describe('websocket integration (socket.io-client)', () => {
  let httpServer: HttpServer;
  let io: SocketServer;
  let port: number;
  const originalEnv = process.env.NODE_ENV;

  beforeAll((done) => {
    process.env.NODE_ENV = 'development';
    httpServer = createServer();
    io = new SocketServer(httpServer);
    setupWebSocketHandlers(io);
    httpServer.listen(() => {
      port = (httpServer.address() as AddressInfo).port;
      done();
    });
  });

  afterAll((done) => {
    process.env.NODE_ENV = originalEnv;
    setIo(null);
    io.close(() => {
      httpServer.close(() => done());
    });
  });

  function buildDevToken(userId: string): string {
    const payload = Buffer.from(
      JSON.stringify({ userId, exp: Date.now() + 60_000 })
    ).toString('base64');
    return `dev_${payload}`;
  }

  function connect(token: string | undefined): ClientSocket {
    return ioClient(`http://localhost:${port}`, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: token ? { token } : {},
    });
  }

  it('rejects connections without a valid token', (done) => {
    const client = connect(undefined);
    client.on('connect_error', (err) => {
      expect(err.message).toBe('Unauthorized');
      client.close();
      done();
    });
  });

  it('allows a coach to join and receive a snapshot + broadcast event', (done) => {
    const coach = createCoach();
    const league = createLeague();
    const season = createSeason({ leagueId: league.id });
    const team = createTeam({ seasonId: season.id });
    const role = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
    const staff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: role.id });
    const game = createGame({
      teamId: team.id,
      status: 'IN_PROGRESS',
      homeScore: 6,
      awayScore: 4,
    });
    const existingEvent = createGameEvent({ gameId: game.id, eventType: 'SHOT' });

    // Mock resolveSocketUser -> dev token path pulls user by id.
    (mockPrisma.user.findUnique as jest.Mock).mockImplementation((args: { where: { id?: string } }) => {
      if (args?.where?.id === coach.id) {
        return Promise.resolve({
          id: coach.id,
          email: coach.email,
          name: coach.name,
          role: coach.role,
        });
      }
      return Promise.resolve(coach);
    });

    // handleJoinGame: findUnique(game) for auth, then for snapshot.
    (mockPrisma.game.findUnique as jest.Mock)
      .mockResolvedValueOnce({ id: game.id, teamId: team.id })
      .mockResolvedValueOnce({
        ...game,
        events: [existingEvent],
      });

    // canAccessTeam: staff check
    (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
      ...team,
      season: { ...season, league: { ...league, admins: [] } },
    });
    (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(staff);

    const client = connect(buildDevToken(coach.id));

    client.on('connect_error', (err) => {
      client.close();
      done(err);
    });

    client.on('connect', () => {
      client.once('game-snapshot', (snapshot: unknown) => {
        const snap = snapshot as {
          game: { id: string; status: string; homeScore: number; awayScore: number };
          events: Array<{ id: string }>;
        };
        expect(snap.game.id).toBe(game.id);
        expect(snap.game.status).toBe('IN_PROGRESS');
        expect(snap.events.map((e) => e.id)).toContain(existingEvent.id);

        // After snapshot, simulate a new event being broadcast.
        client.once('game-event', (payload: unknown) => {
          const msg = payload as {
            event: { id: string; eventType: string };
            score: { homeScore: number; awayScore: number };
          };
          expect(msg.event.id).toBe('evt-broadcast');
          expect(msg.event.eventType).toBe('REBOUND');
          expect(msg.score).toEqual({ homeScore: 6, awayScore: 4 });
          client.close();
          done();
        });

        // Give the server a tick to finish the join before broadcasting.
        setTimeout(() => {
          const broadcastEvent = {
            id: 'evt-broadcast',
            gameId: game.id,
            playerId: null,
            eventType: 'REBOUND',
            timestamp: new Date(),
            metadata: {},
            createdAt: new Date(),
          };
          emitGameEvent(game.id, {
            event: broadcastEvent as unknown as Parameters<typeof emitGameEvent>[1]['event'],
            score: { homeScore: 6, awayScore: 4 },
          });
        }, 25);
      });

      client.emit('join-game', { gameId: game.id }, (response: unknown) => {
        const resp = response as { success: boolean; gameId?: string };
        expect(resp.success).toBe(true);
        expect(resp.gameId).toBe(game.id);
      });
    });
  }, 10000);
});
