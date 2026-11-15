/**
 * A deleted or converted account's live socket stops receiving broadcasts
 * without waiting for its token to expire (#1004), against a REAL Postgres,
 * the real `AccountService` and a real Socket.io transport.
 *
 * Every client holds a token valid for an hour, so the expiry re-check
 * (`scheduleSocketReauth`) cannot be what closes it. Two paths:
 *  - in-process (the API routes): the Socket.io server is registered, and
 *    `deleteAccount` / `convertToManaged` close the sockets on their own;
 *  - out-of-process (the operator scripts): no server is registered while the
 *    service runs (as in `scripts/*.ts`), the socket stays open, and the
 *    API's revocation sweep (`sweepRevokedSockets`, driven by hand here
 *    instead of by its 10 s timer) reads the rows and closes it.
 * Rows carry the run id and are removed in afterAll.
 */
jest.unmock('../../src/models');
import { createServer, type Server as HttpServer } from 'http';
import type { AddressInfo } from 'net';
import { Server as SocketServer } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import prisma from '../../src/models';
import { AccountService } from '../../src/services/account-service';
import * as uploadService from '../../src/services/upload-service';
import { WorkOSService } from '../../src/services/workos-service';
import { emitGameEvent, setupWebSocketHandlers } from '../../src/websocket';
import type { GameEventBroadcast } from '../../src/websocket/emit';
import { REAUTH_REQUIRED_EVENT } from '../../src/websocket/game-events';
import { setIo } from '../../src/websocket/io-registry';
import { resetSocketRateLimits } from '../../src/websocket/rate-limit';
import { stopRevocationSweep, sweepRevokedSockets } from '../../src/websocket/revocation';
import { devToken } from '../support/auth-fixtures';
import { DbFixtures, type Org } from '../support/db-fixtures';

jest.setTimeout(30000);

const fx = new DbFixtures(prisma, 'sockrev');
const HOUR_MS = 60 * 60 * 1000;

let httpServer: HttpServer;
let io: SocketServer;
let port: number;
const originalEnv = process.env.NODE_ENV;
const clients: ClientSocket[] = [];
let spies: jest.SpyInstance[] = [];

/** A claimed, age-confirmed player account rostered on `org`, with a WorkOS identity. */
async function player(key: string, org: Org): Promise<{ id: string; workosUserId: string }> {
  const id = await fx.user(key, 'PLAYER');
  const workosUserId = `workos-${key}-${fx.run}`;
  await prisma.user.update({
    where: { id },
    data: { workosUserId, emailVerified: true, isManaged: false, ageConfirmedAt: new Date() },
  });
  await fx.member(id, org);
  return { id, workosUserId };
}

interface LiveClient {
  socket: ClientSocket;
  events: unknown[];
  reauth: Promise<void>;
  closed: Promise<string>;
}

/** Connect, join the game room, and record what arrives. */
async function liveClient(token: string, gameId: string): Promise<LiveClient> {
  const socket = ioClient(`http://localhost:${port}`, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    auth: { token },
  });
  clients.push(socket);
  const events: unknown[] = [];
  socket.on('game-event', (payload: unknown) => events.push(payload));
  const reauth = new Promise<void>((resolve) => socket.once(REAUTH_REQUIRED_EVENT, () => resolve()));
  const closed = new Promise<string>((resolve) => socket.once('disconnect', (reason) => resolve(reason)));
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
  const ack = await socket.timeout(5000).emitWithAck('join-game', { gameId });
  expect(ack).toEqual({ success: true, gameId });
  return { socket, events, reauth, closed };
}

function broadcast(gameId: string, seq: number): void {
  emitGameEvent(gameId, {
    event: { id: `ev-${seq}`, gameId } as unknown as GameEventBroadcast['event'],
    score: { homeScore: seq, awayScore: 0 },
  });
}

/** Let the transport deliver, or not. */
function settle(ms = 150): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Proves the client receives broadcasts now, before the account changes. */
async function expectReceiving(client: LiveClient, gameId: string): Promise<void> {
  const before = client.events.length;
  broadcast(gameId, before + 1);
  await settle();
  expect(client.events.length).toBe(before + 1);
}

/** Proves the client got reauth_required, lost its transport, and misses later broadcasts. */
async function expectCutOff(client: LiveClient, gameId: string): Promise<void> {
  await client.reauth;
  // A transport close, which socket.io-client auto-reconnects from.
  expect(await client.closed).toBe('transport close');
  const before = client.events.length;
  broadcast(gameId, 100);
  await settle();
  expect(client.events.length).toBe(before);
}

beforeAll(async () => {
  await fx.requireDatabase();
  process.env.NODE_ENV = 'development';
  httpServer = createServer();
  io = new SocketServer(httpServer);
  setupWebSocketHandlers(io);
  // The sweep is driven by hand below, not by its timer.
  stopRevocationSweep();
  await new Promise<void>((resolve) => httpServer.listen(() => resolve()));
  port = (httpServer.address() as AddressInfo).port;
});

beforeEach(() => {
  resetSocketRateLimits();
  setIo(io);
  spies = [
    jest.spyOn(WorkOSService, 'deleteUser').mockResolvedValue(undefined),
    jest.spyOn(WorkOSService, 'revokeAllSessions').mockResolvedValue({ revoked: 0, failed: 0 }),
    jest.spyOn(uploadService, 'deleteAvatarObject').mockResolvedValue('deleted'),
  ];
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  for (const client of clients.splice(0)) client.close();
});

afterAll(async () => {
  process.env.NODE_ENV = originalEnv;
  setIo(null);
  await new Promise<void>((resolve) => io.close(() => resolve()));
  await fx.cleanup();
  await prisma.$disconnect();
});

/**
 * A WorkOS-verified session for `workosUserId`, valid for an hour: the path a
 * production client takes, and the one a conversion (which keeps the row but
 * clears its WorkOS id) has to be caught on.
 */
function workosToken(workosUserId: string): string {
  const token = `workos-token-${workosUserId}`;
  const now = Math.floor(Date.now() / 1000);
  spies.push(
    jest.spyOn(WorkOSService, 'verifyToken').mockImplementation(async (presented) =>
      presented === token ? { id: workosUserId, expiresAt: now + 3600, issuedAt: now } : null
    )
  );
  return token;
}

describe('socket revocation after account deletion (#1004)', () => {
  it('in-process: deleteAccount closes the socket at once', async () => {
    const org = await fx.org('del-in');
    const gameId = await fx.game(org, { status: 'IN_PROGRESS' });
    const kid = await player('del-in-kid', org);
    const bystander = await player('del-in-other', org);
    const client = await liveClient(devToken({ userId: kid.id, exp: Date.now() + HOUR_MS }), gameId);
    const other = await liveClient(devToken({ userId: bystander.id, exp: Date.now() + HOUR_MS }), gameId);
    await expectReceiving(client, gameId);

    await AccountService.deleteAccount(kid.id, { actorId: kid.id, mode: 'self' });

    await expectCutOff(client, gameId);
    // Another member of the same game keeps receiving.
    expect(other.socket.connected).toBe(true);
    expect(other.events.length).toBeGreaterThan(0);
  });

  it('operator script: the sweep closes the socket of an account deleted in another process', async () => {
    const org = await fx.org('del-out');
    const gameId = await fx.game(org, { status: 'IN_PROGRESS' });
    const kid = await player('del-out-kid', org);
    const bystander = await player('del-out-other', org);
    const client = await liveClient(devToken({ userId: kid.id, exp: Date.now() + HOUR_MS }), gameId);
    const other = await liveClient(devToken({ userId: bystander.id, exp: Date.now() + HOUR_MS }), gameId);

    // scripts/data-subject-request.ts has no Socket.io server.
    setIo(null);
    await AccountService.deleteAccount(kid.id, { actorId: 'operator', mode: 'operator' });
    setIo(io);
    await settle();
    await expectReceiving(client, gameId);

    expect(await sweepRevokedSockets(io)).toBe(1);

    await expectCutOff(client, gameId);
    expect(other.socket.connected).toBe(true);
  });
});

describe('socket revocation after conversion to a managed record (#1004)', () => {
  async function convertible(key: string): Promise<{ org: Org; gameId: string; kid: { id: string; workosUserId: string } }> {
    const org = await fx.org(key);
    const head = await fx.user(`${key}-head`, 'COACH');
    await fx.staff(head, org);
    const gameId = await fx.game(org, { status: 'IN_PROGRESS' });
    const kid = await player(`${key}-kid`, org);
    return { org, gameId, kid };
  }

  it('in-process: convertToManaged closes the socket at once', async () => {
    const { gameId, kid } = await convertible('conv-in');
    const client = await liveClient(workosToken(kid.workosUserId), gameId);
    await expectReceiving(client, gameId);

    await AccountService.convertToManaged(kid.id, { actorId: 'operator' });

    await expectCutOff(client, gameId);
  });

  it('operator script: the sweep closes the socket once the row lost its WorkOS id', async () => {
    const { gameId, kid } = await convertible('conv-out');
    const client = await liveClient(workosToken(kid.workosUserId), gameId);

    // scripts/convert-to-managed.ts has no Socket.io server.
    setIo(null);
    await AccountService.convertToManaged(kid.id, { actorId: 'operator' });
    setIo(io);
    await settle();
    // The row survives (managed, no login), so only the WorkOS id tells.
    expect(await prisma.user.findUnique({ where: { id: kid.id }, select: { deletedAt: true, workosUserId: true } }))
      .toEqual({ deletedAt: null, workosUserId: null });
    await expectReceiving(client, gameId);

    expect(await sweepRevokedSockets(io)).toBe(1);

    await expectCutOff(client, gameId);
  });

  it('in-process: an under-age answer that un-claims the row closes the socket at once', async () => {
    const { gameId, kid } = await convertible('underage-in');
    const client = await liveClient(workosToken(kid.workosUserId), gameId);
    await expectReceiving(client, gameId);

    expect(await AccountService.refuseUnderage(kid.id)).toMatchObject({ outcome: 'unclaimed' });

    await expectCutOff(client, gameId);
  });

  it('the sweep keeps a live account’s socket', async () => {
    const { gameId, kid } = await convertible('conv-keep');
    const client = await liveClient(workosToken(kid.workosUserId), gameId);

    expect(await sweepRevokedSockets(io)).toBe(0);

    await expectReceiving(client, gameId);
    expect(client.socket.connected).toBe(true);
  });
});
