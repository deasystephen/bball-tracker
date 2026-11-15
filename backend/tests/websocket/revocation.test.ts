/**
 * Closing the sockets of a deleted or converted account (#1004): the
 * in-process call and the sweep, against fake sockets and the mocked Prisma.
 * The real transport is in `game-events.integration.test.ts`; the real
 * AccountService and Postgres in `tests/integration/socket-revocation.db.test.ts`.
 */
import type { Server as SocketServer } from 'socket.io';

jest.mock('../../src/utils/sentry', () => ({
  ...jest.requireActual('../../src/utils/sentry'),
  captureException: jest.fn(),
}));

import { mockPrisma } from '../setup';
import { captureException } from '../../src/utils/sentry';
import { setIo } from '../../src/websocket/io-registry';
import { REAUTH_REQUIRED_EVENT, type GameSocket } from '../../src/websocket/game-events';
import {
  REVOCATION_SWEEP_CHUNK,
  REVOCATION_SWEEP_INTERVAL_MS,
  SOCKET_REVOCATION_SELECT,
  revokeUserSockets,
  sessionRevoked,
  startRevocationSweep,
  stopRevocationSweep,
  sweepRevokedSockets,
  type SocketRevocationRow,
} from '../../src/websocket/revocation';

const findMany = mockPrisma.user.findMany as jest.Mock;

interface FakeSocket {
  id: string;
  connected: boolean;
  data: { user?: { id: string }; workosUserId?: string | null };
  emit: jest.Mock;
  conn: { close: jest.Mock };
}

let counter = 0;
function fakeSocket(userId: string | undefined, workosUserId: string | null = null): FakeSocket {
  counter += 1;
  const socket: FakeSocket = {
    id: `s-${counter}`,
    connected: true,
    data: { ...(userId && { user: { id: userId } }), workosUserId },
    emit: jest.fn(),
    conn: { close: jest.fn() },
  };
  socket.conn.close.mockImplementation(() => {
    socket.connected = false;
  });
  return socket;
}

function fakeIo(sockets: FakeSocket[]): SocketServer {
  const map = new Map(sockets.map((socket) => [socket.id, socket]));
  return { of: () => ({ sockets: map }) } as unknown as SocketServer;
}

function row(id: string, overrides: Partial<SocketRevocationRow> = {}): SocketRevocationRow {
  return { id, workosUserId: null, ageConfirmedAt: new Date(), ageRefusedAt: null, ...overrides };
}

function wasCut(socket: FakeSocket): boolean {
  return socket.emit.mock.calls.some(([event]) => event === REAUTH_REQUIRED_EVENT) && socket.conn.close.mock.calls.length > 0;
}

beforeEach(() => {
  jest.clearAllMocks();
  findMany.mockReset();
});

afterEach(() => {
  setIo(null);
  stopRevocationSweep();
});

describe('sessionRevoked', () => {
  const asSocket = (socket: FakeSocket): GameSocket => socket as unknown as GameSocket;

  it('revokes when the live row is gone (erased or tombstoned)', () => {
    expect(sessionRevoked(asSocket(fakeSocket('u1')), undefined)).toBe(true);
  });

  it('revokes a WorkOS socket whose row no longer carries its WorkOS id (converted or deleted)', () => {
    const socket = asSocket(fakeSocket('u1', 'wos_1'));
    expect(sessionRevoked(socket, row('u1', { workosUserId: null }))).toBe(true);
    expect(sessionRevoked(socket, row('u1', { workosUserId: 'wos_other' }))).toBe(true);
    expect(sessionRevoked(socket, row('u1', { workosUserId: 'wos_1' }))).toBe(false);
  });

  it('checks a dev-token socket on the row and the age gate only', () => {
    const socket = asSocket(fakeSocket('u1', null));
    expect(sessionRevoked(socket, row('u1', { workosUserId: null }))).toBe(false);
    expect(sessionRevoked(socket, row('u1', { workosUserId: 'wos_1' }))).toBe(false);
  });

  it('revokes an account the age gate refuses, as the handshake would', () => {
    const socket = asSocket(fakeSocket('u1'));
    expect(sessionRevoked(socket, row('u1', { ageRefusedAt: new Date() }))).toBe(true);
    expect(sessionRevoked(socket, row('u1', { ageConfirmedAt: null }))).toBe(true);
  });
});

describe('revokeUserSockets (in-process)', () => {
  it('does nothing without a registered Socket.io server (an operator script)', () => {
    expect(revokeUserSockets('u1')).toBe(0);
  });

  it("closes every connected socket of that user with reauth_required and leaves others' alone", () => {
    const mine = [fakeSocket('u1'), fakeSocket('u1')];
    const gone = fakeSocket('u1');
    gone.connected = false;
    const theirs = fakeSocket('u2');
    const anonymous = fakeSocket(undefined);
    setIo(fakeIo([...mine, gone, theirs, anonymous]));

    expect(revokeUserSockets('u1')).toBe(2);
    expect(mine.every(wasCut)).toBe(true);
    expect(wasCut(gone)).toBe(false);
    expect(wasCut(theirs)).toBe(false);
    expect(wasCut(anonymous)).toBe(false);
    // No database or Redis on this path.
    expect(findMany).not.toHaveBeenCalled();
  });

  it('never throws: a failure is logged and left to the sweep', () => {
    const socket = fakeSocket('u1');
    socket.conn.close.mockImplementation(() => {
      throw new Error('boom');
    });
    setIo(fakeIo([socket]));
    expect(revokeUserSockets('u1')).toBe(0);
  });
});

describe('sweepRevokedSockets', () => {
  it('runs no query when this process holds no authenticated socket', async () => {
    expect(await sweepRevokedSockets(fakeIo([fakeSocket(undefined)]))).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('reads the distinct users in one query and closes only the revoked sockets', async () => {
    const deleted = fakeSocket('deleted');
    const converted = fakeSocket('converted', 'wos_c');
    const live = [fakeSocket('live', 'wos_l'), fakeSocket('live', 'wos_l')];
    findMany.mockResolvedValue([row('converted', { workosUserId: null }), row('live', { workosUserId: 'wos_l' })]);

    expect(await sweepRevokedSockets(fakeIo([deleted, converted, ...live]))).toBe(2);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: { id: { in: ['deleted', 'converted', 'live'] }, deletedAt: null },
      select: SOCKET_REVOCATION_SELECT,
    });
    expect(wasCut(deleted)).toBe(true);
    expect(wasCut(converted)).toBe(true);
    expect(live.some(wasCut)).toBe(false);
  });

  it('queries in chunks of REVOCATION_SWEEP_CHUNK users', async () => {
    const sockets = Array.from({ length: REVOCATION_SWEEP_CHUNK + 1 }, (_, i) => fakeSocket(`u${i}`));
    findMany.mockImplementation(({ where }: { where: { id: { in: string[] } } }) =>
      Promise.resolve(where.id.in.map((id) => row(id)))
    );
    expect(await sweepRevokedSockets(fakeIo(sockets))).toBe(0);
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it('skips a socket that disconnected while the query ran', async () => {
    const socket = fakeSocket('deleted');
    findMany.mockImplementation(() => {
      socket.connected = false;
      return Promise.resolve([]);
    });
    expect(await sweepRevokedSockets(fakeIo([socket]))).toBe(0);
    expect(wasCut(socket)).toBe(false);
  });

  it('keeps every socket when the database fails, reporting the first failure of a streak only', async () => {
    const socket = fakeSocket('u1');
    const io = fakeIo([socket]);
    findMany.mockRejectedValue(new Error('db down'));

    expect(await sweepRevokedSockets(io)).toBe(0);
    expect(await sweepRevokedSockets(io)).toBe(0);
    expect(wasCut(socket)).toBe(false);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), { flow: 'socket-revocation-sweep' });

    // Recovery resets the streak: the next outage is reported again.
    findMany.mockResolvedValueOnce([row('u1')]);
    expect(await sweepRevokedSockets(io)).toBe(0);
    findMany.mockRejectedValueOnce(new Error('db down again'));
    await sweepRevokedSockets(io);
    expect(captureException).toHaveBeenCalledTimes(2);
  });
});

describe('startRevocationSweep', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('sweeps every REVOCATION_SWEEP_INTERVAL_MS until stopped, never overlapping runs', async () => {
    const socket = fakeSocket('u1');
    let release: (rows: SocketRevocationRow[]) => void = () => undefined;
    findMany.mockImplementation(
      () =>
        new Promise<SocketRevocationRow[]>((resolve) => {
          release = resolve;
        })
    );
    startRevocationSweep(fakeIo([socket]));

    await jest.advanceTimersByTimeAsync(REVOCATION_SWEEP_INTERVAL_MS);
    expect(findMany).toHaveBeenCalledTimes(1);
    // Still in flight: the next tick is skipped.
    await jest.advanceTimersByTimeAsync(REVOCATION_SWEEP_INTERVAL_MS);
    expect(findMany).toHaveBeenCalledTimes(1);

    release([]);
    await jest.advanceTimersByTimeAsync(REVOCATION_SWEEP_INTERVAL_MS);
    expect(wasCut(socket)).toBe(true);
    expect(findMany).toHaveBeenCalledTimes(1);

    stopRevocationSweep();
    stopRevocationSweep();
    socket.connected = true;
    await jest.advanceTimersByTimeAsync(REVOCATION_SWEEP_INTERVAL_MS * 3);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('survives a sweep that throws', async () => {
    const socket = fakeSocket('u1');
    socket.emit.mockImplementation(() => {
      throw new Error('emit failed');
    });
    findMany.mockResolvedValue([]);
    startRevocationSweep(fakeIo([socket]));
    await jest.advanceTimersByTimeAsync(REVOCATION_SWEEP_INTERVAL_MS);
    await jest.advanceTimersByTimeAsync(REVOCATION_SWEEP_INTERVAL_MS);
    expect(findMany).toHaveBeenCalledTimes(2);
  });
});
