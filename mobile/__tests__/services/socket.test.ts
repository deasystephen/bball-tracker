/**
 * Tests for the socket.io-client singleton wrapper, including handshake
 * recovery (audit #17b): token refresh on `Unauthorized`, back-off on
 * `Service unavailable`, retry caps, and counter reset on connect.
 */

import { io } from 'socket.io-client';

import {
  getSocket,
  resetSocket,
  handleConnectError,
  handleReauthRequired,
  isSocketRecovering,
  MIN_PROACTIVE_REFRESH_DELAY_MS,
  PROACTIVE_REFRESH_LEAD_MS,
  REAUTH_REQUIRED_EVENT,
  REFRESH_AUTH_EVENT,
  MAX_AUTH_REFRESHES,
  MAX_UNAVAILABLE_RETRIES,
  BASE_BACKOFF_MS,
  UNAUTHORIZED_MESSAGE,
  SERVICE_UNAVAILABLE_MESSAGE,
} from '../../services/socket';
import { refreshAccessToken } from '../../services/api-client';
import { addBreadcrumb } from '../../services/sentry';

jest.mock('socket.io-client', () => ({
  io: jest.fn(),
}));

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { extra: { apiUrl: 'http://test.local' } } },
}));

let mockAccessToken: string | null = 'tok_abc';
const mockAuthListeners = new Set<(state: { accessToken: string | null }) => void>();
jest.mock('../../store/auth-store', () => ({
  useAuthStore: {
    getState: jest.fn(() => ({ accessToken: mockAccessToken })),
    subscribe: jest.fn((listener: (state: { accessToken: string | null }) => void) => {
      mockAuthListeners.add(listener);
      return () => mockAuthListeners.delete(listener);
    }),
  },
}));

// jest.setup.js mocks api-client without refreshAccessToken; add it here.
jest.mock('../../services/api-client', () => ({
  apiClient: { get: jest.fn(), post: jest.fn() },
  refreshAccessToken: jest.fn(),
}));

jest.mock('../../services/sentry', () => ({
  addBreadcrumb: jest.fn(),
}));

const mockedIo = io as jest.Mock;
const mockedRefresh = refreshAccessToken as jest.Mock;
const mockedCrumb = addBreadcrumb as jest.Mock;
const socketCrumbs = () => mockedCrumb.mock.calls.map((c) => c[0]).filter((c) => c.category === 'socket');

interface FakeSocket {
  connected?: boolean;
  emit: jest.Mock;
  handlers: Record<string, ((...args: unknown[]) => void)[]>;
  on: jest.Mock;
  removeAllListeners: jest.Mock;
  disconnect: jest.Mock;
  connect: jest.Mock;
  fire: (event: string, ...args: unknown[]) => void;
}

const makeFake = (): FakeSocket => {
  const fake: FakeSocket = {
    emit: jest.fn(),
    handlers: {},
    on: jest.fn((event: string, handler: (...args: unknown[]) => void) => {
      fake.handlers[event] = [...(fake.handlers[event] ?? []), handler];
      return fake;
    }),
    removeAllListeners: jest.fn(),
    disconnect: jest.fn(),
    connect: jest.fn(),
    fire: (event, ...args) => (fake.handlers[event] ?? []).forEach((h) => h(...args)),
  };
  return fake;
};

describe('socket wrapper', () => {
  beforeEach(() => {
    resetSocket();
    mockAccessToken = 'tok_abc';
    mockedIo.mockReset();
    mockedRefresh.mockReset();
    mockedCrumb.mockReset();
  });

  describe('breadcrumbs (#617)', () => {
    it('crumbs connect, reconnect and disconnect with socket.io reasons only', () => {
      const fake = makeFake();
      mockedIo.mockReturnValue(fake);
      getSocket();

      fake.fire('connect');
      fake.fire('disconnect', 'transport close');
      fake.fire('connect');

      expect(socketCrumbs()).toEqual([
        { category: 'socket', message: 'connected', level: 'info', data: { recovered: false } },
        { category: 'socket', message: 'disconnected', level: 'warning', data: { reason: 'transport close' } },
        { category: 'socket', message: 'reconnected', level: 'info', data: { recovered: false } },
      ]);
    });

    it('crumbs a handshake rejection and each recovery decision', async () => {
      jest.useFakeTimers();
      const fake = makeFake();
      mockedIo.mockReturnValue(fake);
      getSocket();
      mockedRefresh.mockResolvedValueOnce({ status: 'ok', accessToken: 'new' });

      fake.fire('connect_error', new Error(UNAUTHORIZED_MESSAGE));
      await Promise.resolve();
      await Promise.resolve();
      fake.fire('connect_error', new Error(SERVICE_UNAVAILABLE_MESSAGE));

      expect(socketCrumbs().map((c) => [c.message, c.level, c.data])).toEqual([
        ['connect_error', 'warning', { message: UNAUTHORIZED_MESSAGE }],
        ['recovery: refreshing token', 'info', { attempt: 1 }],
        ['connect_error', 'warning', { message: SERVICE_UNAVAILABLE_MESSAGE }],
        ['recovery: backing off', 'info', { reason: SERVICE_UNAVAILABLE_MESSAGE, attempt: 1, delayMs: BASE_BACKOFF_MS }],
      ]);
      jest.useRealTimers();
    });

    it('resetSocket forgets the connection history so the next socket crumbs "connected"', () => {
      const first = makeFake();
      mockedIo.mockReturnValue(first);
      getSocket();
      first.fire('connect');
      resetSocket();

      const second = makeFake();
      mockedIo.mockReturnValue(second);
      getSocket();
      second.fire('connect');

      expect(socketCrumbs().map((c) => c.message)).toEqual(['connected', 'connected']);
    });
  });

  it('lazily constructs a single socket', () => {
    mockedIo.mockReturnValue(makeFake());

    const a = getSocket();
    const b = getSocket();

    expect(a).toBe(b);
    expect(mockedIo).toHaveBeenCalledTimes(1);
  });

  it('passes the configured base URL and websocket-only transport', () => {
    mockedIo.mockReturnValue(makeFake());

    getSocket();

    const [url, opts] = mockedIo.mock.calls[0];
    expect(url).toBe('http://test.local');
    expect(opts.transports).toEqual(['websocket']);
    expect(opts.reconnection).toBe(true);
  });

  it('supplies the current token via the auth callback on each call', () => {
    mockedIo.mockReturnValue(makeFake());

    getSocket();

    const opts = mockedIo.mock.calls[0][1];
    const cb = jest.fn();
    opts.auth(cb);
    expect(cb).toHaveBeenCalledWith({ token: 'tok_abc' });
  });

  it('resetSocket disconnects and allows a fresh build', () => {
    const fake = makeFake();
    mockedIo.mockReturnValue(fake);

    getSocket();
    resetSocket();

    expect(fake.removeAllListeners).toHaveBeenCalled();
    expect(fake.disconnect).toHaveBeenCalled();

    mockedIo.mockReturnValue(makeFake());
    getSocket();
    expect(mockedIo).toHaveBeenCalledTimes(2);
  });

  describe('handshake recovery', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it('wires connect / connect_error listeners on the singleton', () => {
      const fake = makeFake();
      mockedIo.mockReturnValue(fake);
      getSocket();
      expect(fake.handlers.connect).toHaveLength(1);
      expect(fake.handlers.connect_error).toHaveLength(1);
    });

    it('refreshes the token and reconnects on Unauthorized', async () => {
      const fake = makeFake();
      mockedIo.mockReturnValue(fake);
      mockedRefresh.mockResolvedValue({ status: 'ok', accessToken: 'fresh' });
      const socket = getSocket();

      const pending = handleConnectError(socket, new Error('Unauthorized'));
      expect(isSocketRecovering()).toBe(true);
      await pending;

      expect(mockedRefresh).toHaveBeenCalledTimes(1);
      expect(fake.connect).toHaveBeenCalledTimes(1);
    });

    it('gives up after MAX_AUTH_REFRESHES consecutive Unauthorized handshakes', async () => {
      const fake = makeFake();
      mockedIo.mockReturnValue(fake);
      mockedRefresh.mockResolvedValue({ status: 'ok', accessToken: 'fresh' });
      const socket = getSocket();

      for (let i = 0; i < MAX_AUTH_REFRESHES + 2; i += 1) {
        await handleConnectError(socket, new Error('Unauthorized'));
      }

      expect(mockedRefresh).toHaveBeenCalledTimes(MAX_AUTH_REFRESHES);
      expect(fake.connect).toHaveBeenCalledTimes(MAX_AUTH_REFRESHES);
      expect(isSocketRecovering()).toBe(false);
    });

    it('stops (without reconnecting) when the refresh token is rejected', async () => {
      const fake = makeFake();
      mockedIo.mockReturnValue(fake);
      mockedRefresh.mockResolvedValue({ status: 'rejected' });
      const socket = getSocket();

      await handleConnectError(socket, new Error('Unauthorized'));

      expect(fake.connect).not.toHaveBeenCalled();
      expect(isSocketRecovering()).toBe(false);
    });

    it('backs off and retries when the refresh is transiently unavailable', async () => {
      const fake = makeFake();
      mockedIo.mockReturnValue(fake);
      mockedRefresh.mockResolvedValue({ status: 'unavailable', error: new Error('503') });
      const socket = getSocket();

      await handleConnectError(socket, new Error('Unauthorized'));
      expect(fake.connect).not.toHaveBeenCalled();
      expect(isSocketRecovering()).toBe(true);

      jest.advanceTimersByTime(BASE_BACKOFF_MS);
      expect(fake.connect).toHaveBeenCalledTimes(1);
    });

    it('backs off exponentially on Service unavailable and caps the retries', async () => {
      const fake = makeFake();
      mockedIo.mockReturnValue(fake);
      const socket = getSocket();

      for (let i = 0; i < MAX_UNAVAILABLE_RETRIES; i += 1) {
        await handleConnectError(socket, new Error('Service unavailable'));
        expect(isSocketRecovering()).toBe(true);
        const delay = BASE_BACKOFF_MS * 2 ** i;
        jest.advanceTimersByTime(delay - 1);
        expect(fake.connect).toHaveBeenCalledTimes(i);
        jest.advanceTimersByTime(1);
        expect(fake.connect).toHaveBeenCalledTimes(i + 1);
      }

      // One more: cap reached, no timer scheduled.
      await handleConnectError(socket, new Error('Service unavailable'));
      jest.advanceTimersByTime(BASE_BACKOFF_MS * 2 ** MAX_UNAVAILABLE_RETRIES);
      expect(fake.connect).toHaveBeenCalledTimes(MAX_UNAVAILABLE_RETRIES);
      expect(isSocketRecovering()).toBe(false);
      expect(mockedRefresh).not.toHaveBeenCalled();
    });

    it('resets the retry budget on a successful connect', async () => {
      const fake = makeFake();
      mockedIo.mockReturnValue(fake);
      mockedRefresh.mockResolvedValue({ status: 'ok', accessToken: 'fresh' });
      const socket = getSocket();

      for (let i = 0; i < MAX_AUTH_REFRESHES; i += 1) {
        await handleConnectError(socket, new Error('Unauthorized'));
      }
      fake.fire('connect');
      expect(isSocketRecovering()).toBe(false);

      await handleConnectError(socket, new Error('Unauthorized'));
      expect(mockedRefresh).toHaveBeenCalledTimes(MAX_AUTH_REFRESHES + 1);
    });

    it('backs off and retries on Rate limited (backend socket limiter, audit #16)', async () => {
      const fake = makeFake();
      mockedIo.mockReturnValue(fake);
      const socket = getSocket();

      await handleConnectError(socket, new Error('Rate limited'));

      expect(isSocketRecovering()).toBe(true);
      jest.advanceTimersByTime(BASE_BACKOFF_MS);
      expect(fake.connect).toHaveBeenCalledTimes(1);
      expect(mockedRefresh).not.toHaveBeenCalled();
    });

    it('ignores other connect_error reasons (socket.io retries those itself)', async () => {
      const fake = makeFake();
      mockedIo.mockReturnValue(fake);
      const socket = getSocket();

      await handleConnectError(socket, new Error('xhr poll error'));

      expect(mockedRefresh).not.toHaveBeenCalled();
      expect(fake.connect).not.toHaveBeenCalled();
      expect(isSocketRecovering()).toBe(false);
    });

    it('does not reconnect a socket that was reset (logout) mid-recovery', async () => {
      const fake = makeFake();
      mockedIo.mockReturnValue(fake);
      let resolveRefresh: (v: unknown) => void = () => undefined;
      mockedRefresh.mockReturnValue(new Promise((res) => { resolveRefresh = res; }));
      const socket = getSocket();

      const pending = handleConnectError(socket, new Error('Unauthorized'));
      resetSocket();
      resolveRefresh({ status: 'ok', accessToken: 'fresh' });
      await pending;

      expect(fake.connect).not.toHaveBeenCalled();

      // A pending back-off timer is also cancelled by resetSocket.
      const fake2 = makeFake();
      mockedIo.mockReturnValue(fake2);
      const socket2 = getSocket();
      await handleConnectError(socket2, new Error('Service unavailable'));
      resetSocket();
      jest.advanceTimersByTime(BASE_BACKOFF_MS * 4);
      expect(fake2.connect).not.toHaveBeenCalled();
    });

    it('routes the singleton connect_error listener through the recovery handler', async () => {
      const fake = makeFake();
      mockedIo.mockReturnValue(fake);
      mockedRefresh.mockResolvedValue({ status: 'ok', accessToken: 'fresh' });
      getSocket();

      fake.fire('connect_error', new Error('Unauthorized'));
      await Promise.resolve();
      await Promise.resolve();

      expect(mockedRefresh).toHaveBeenCalledTimes(1);
      expect(fake.connect).toHaveBeenCalledTimes(1);
    });
  });

  describe('server re-auth (#49)', () => {
    const b64url = (value: object): string =>
      Buffer.from(JSON.stringify(value)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const jwt = (expMs: number): string => `${b64url({ alg: 'RS256' })}.${b64url({ sub: 'u', exp: Math.floor(expMs / 1000) })}.sig`;

    /** Run the handshake (auth callback) with `token` and fire `connect`. */
    const connectWith = (fake: FakeSocket, token: string): void => {
      mockAccessToken = token;
      const options = mockedIo.mock.calls[0][1] as { auth: (cb: (data: unknown) => void) => void };
      options.auth(() => undefined);
      fake.connected = true;
      fake.fire('connect');
    };
    const setStoredToken = (token: string | null): void => {
      mockAccessToken = token;
      mockAuthListeners.forEach((listener) => listener({ accessToken: token }));
    };
    const refreshAuthEmits = (fake: FakeSocket) => fake.emit.mock.calls.filter((c) => c[0] === REFRESH_AUTH_EVENT);

    afterEach(() => {
      jest.useRealTimers();
    });

    describe('in-band refresh-auth', () => {
      it('sends refresh-auth when the stored token changes while connected, once per token', () => {
        const fake = makeFake();
        mockedIo.mockReturnValue(fake);
        getSocket();
        connectWith(fake, 'tok_handshake');
        expect(refreshAuthEmits(fake)).toHaveLength(0);

        setStoredToken('tok_fresh');
        setStoredToken('tok_fresh');

        expect(refreshAuthEmits(fake)).toHaveLength(1);
        expect(refreshAuthEmits(fake)[0][1]).toEqual({ token: 'tok_fresh' });

        // The ack is only crumbed (codes, never the token).
        const ack = refreshAuthEmits(fake)[0][2] as (r: unknown) => void;
        ack({ success: false, code: 'unauthorized' });
        expect(socketCrumbs()).toContainEqual({
          category: 'socket',
          message: 'in-band refresh refused',
          level: 'warning',
          data: { code: 'unauthorized' },
        });
        expect(JSON.stringify(socketCrumbs())).not.toContain('tok_fresh');
      });

      it('keeps the held token on a refused ack and retries the sync exactly once', () => {
        jest.useFakeTimers();
        const fake = makeFake();
        mockedIo.mockReturnValue(fake);
        mockedRefresh.mockResolvedValue({ status: 'unavailable' });
        getSocket();
        connectWith(fake, jwt(Date.now() + 5 * 60_000));
        const offered = jwt(Date.now() + 60 * 60_000);

        setStoredToken(offered);
        const ack1 = refreshAuthEmits(fake)[0][2] as (r: unknown) => void;
        ack1({ success: false, code: 'unauthorized' });
        expect(refreshAuthEmits(fake)).toHaveLength(2);
        expect(refreshAuthEmits(fake)[1][1]).toEqual({ token: offered });
        const ack2 = refreshAuthEmits(fake)[1][2] as (r: unknown) => void;
        ack2({ success: false, code: 'unauthorized' });
        expect(refreshAuthEmits(fake)).toHaveLength(2);

        // The server still holds the handshake token, so the proactive refresh
        // stays keyed to its expiry (4 min), not the refused token's (59 min).
        jest.advanceTimersByTime(5 * 60_000 - PROACTIVE_REFRESH_LEAD_MS);
        expect(mockedRefresh).toHaveBeenCalledTimes(1);
      });

      it('does not retry an offer the server superseded with a newer one', () => {
        const fake = makeFake();
        mockedIo.mockReturnValue(fake);
        getSocket();
        connectWith(fake, 'tok_handshake');
        setStoredToken('tok_1');
        setStoredToken('tok_2');
        expect(refreshAuthEmits(fake).map((c) => c[1])).toEqual([{ token: 'tok_1' }, { token: 'tok_2' }]);

        (refreshAuthEmits(fake)[0][2] as (r: unknown) => void)({ success: false, code: 'superseded' });
        expect(refreshAuthEmits(fake)).toHaveLength(2);
      });

      it('moves the proactive timer to the accepted token only on a success ack', () => {
        jest.useFakeTimers();
        const fake = makeFake();
        mockedIo.mockReturnValue(fake);
        mockedRefresh.mockResolvedValue({ status: 'unavailable' });
        getSocket();
        connectWith(fake, jwt(Date.now() + 5 * 60_000));
        setStoredToken(jwt(Date.now() + 60 * 60_000));
        (refreshAuthEmits(fake)[0][2] as (r: unknown) => void)({ success: true });
        expect(jest.getTimerCount()).toBe(1);

        jest.advanceTimersByTime(30 * 60_000);
        expect(mockedRefresh).not.toHaveBeenCalled();
        jest.advanceTimersByTime(29 * 60_000);
        expect(mockedRefresh).toHaveBeenCalledTimes(1);
      });

      it('keeps one proactive timer when connect also sends a refresh that landed mid-handshake', () => {
        jest.useFakeTimers();
        const fake = makeFake();
        mockedIo.mockReturnValue(fake);
        getSocket();
        mockAccessToken = jwt(Date.now() + 5 * 60_000);
        const options = mockedIo.mock.calls[0][1] as { auth: (cb: (data: unknown) => void) => void };
        options.auth(() => undefined);
        mockAccessToken = jwt(Date.now() + 10 * 60_000);
        fake.connected = true;
        fake.fire('connect');

        expect(refreshAuthEmits(fake)).toHaveLength(1);
        expect(jest.getTimerCount()).toBe(1);
      });

      it('never refreshes sooner than the floor when the device clock runs ahead of WorkOS', () => {
        jest.useFakeTimers();
        const fake = makeFake();
        mockedIo.mockReturnValue(fake);
        mockedRefresh.mockResolvedValue({ status: 'ok', accessToken: 'fresh' });
        getSocket();
        // To a clock 10 minutes fast, a fresh 5-minute token already looks expired.
        connectWith(fake, jwt(Date.now() - 5 * 60_000));

        jest.advanceTimersByTime(MIN_PROACTIVE_REFRESH_DELAY_MS - 1);
        expect(mockedRefresh).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1);
        expect(mockedRefresh).toHaveBeenCalledTimes(1);
      });

      it('waits half the remaining lifetime when that is longer than lifetime minus the lead', () => {
        jest.useFakeTimers();
        const fake = makeFake();
        mockedIo.mockReturnValue(fake);
        mockedRefresh.mockResolvedValue({ status: 'ok', accessToken: 'fresh' });
        jest.setSystemTime(new Date('2026-10-18T12:00:00Z')); // whole second: JWT exp is in seconds
        getSocket();
        connectWith(fake, jwt(Date.now() + 90_000));

        jest.advanceTimersByTime(45_000 - 1);
        expect(mockedRefresh).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1);
        expect(mockedRefresh).toHaveBeenCalledTimes(1);
      });

      it('does not send refresh-auth while disconnected, or for a cleared token', () => {
        const fake = makeFake();
        mockedIo.mockReturnValue(fake);
        getSocket();
        connectWith(fake, 'tok_handshake');
        setStoredToken(null);
        fake.connected = false;
        setStoredToken('tok_fresh');
        expect(refreshAuthEmits(fake)).toHaveLength(0);
      });

      it('sends the newer token on connect when a refresh landed during the handshake', () => {
        const fake = makeFake();
        mockedIo.mockReturnValue(fake);
        getSocket();
        mockAccessToken = 'tok_handshake';
        const options = mockedIo.mock.calls[0][1] as { auth: (cb: (data: unknown) => void) => void };
        options.auth(() => undefined);
        mockAccessToken = 'tok_fresh';
        fake.connected = true;
        fake.fire('connect');

        expect(refreshAuthEmits(fake).map((c) => c[1])).toEqual([{ token: 'tok_fresh' }]);
      });

      it('refreshes ahead of the server-held token expiry while connected', async () => {
        jest.useFakeTimers();
        const fake = makeFake();
        mockedIo.mockReturnValue(fake);
        mockedRefresh.mockResolvedValue({ status: 'ok', accessToken: 'fresh' });
        getSocket();
        connectWith(fake, jwt(Date.now() + 5 * 60_000));

        jest.advanceTimersByTime(5 * 60_000 - PROACTIVE_REFRESH_LEAD_MS - 1_000);
        expect(mockedRefresh).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1_000);
        expect(mockedRefresh).toHaveBeenCalledTimes(1);
      });

      it('cancels the proactive refresh on disconnect and on reset (logout)', () => {
        jest.useFakeTimers();
        const fake = makeFake();
        mockedIo.mockReturnValue(fake);
        getSocket();
        connectWith(fake, jwt(Date.now() + 5 * 60_000));
        fake.fire('disconnect', 'transport close');
        jest.advanceTimersByTime(10 * 60_000);
        expect(mockedRefresh).not.toHaveBeenCalled();

        connectWith(fake, jwt(Date.now() + 5 * 60_000));
        resetSocket();
        jest.advanceTimersByTime(10 * 60_000);
        expect(mockedRefresh).not.toHaveBeenCalled();
        // The store subscription is gone too.
        expect(mockAuthListeners.size).toBe(0);
      });
    });

    describe('reauth_required (server closed the connection)', () => {
      it('refreshes when the server held the stored token, without forcing a reconnect', async () => {
        const fake = makeFake();
        mockedIo.mockReturnValue(fake);
        mockedRefresh.mockResolvedValue({ status: 'ok', accessToken: 'fresh' });
        getSocket();
        connectWith(fake, jwt(Date.now() - 1_000));

        expect(REAUTH_REQUIRED_EVENT).toBe('reauth_required');
        fake.fire(REAUTH_REQUIRED_EVENT, {});
        expect(isSocketRecovering()).toBe(true);
        await Promise.resolve();
        await Promise.resolve();

        expect(mockedRefresh).toHaveBeenCalledTimes(1);
        // The server closed the transport; socket.io reconnects on its own and
        // the auth callback reads the refreshed token.
        expect(fake.connect).not.toHaveBeenCalled();
        expect(socketCrumbs().map((c) => c.message)).toContain('reauth required: refreshing token');

        fake.fire('connect');
        expect(isSocketRecovering()).toBe(false);
      });

      it('reconnects with a newer unexpired stored token instead of spending a refresh', async () => {
        const fake = makeFake();
        mockedIo.mockReturnValue(fake);
        getSocket();
        connectWith(fake, jwt(Date.now() - 1_000));
        fake.connected = false; // the server is closing it
        mockAccessToken = jwt(Date.now() + 10 * 60_000);

        await handleReauthRequired(fake as unknown as Parameters<typeof handleReauthRequired>[0]);

        expect(mockedRefresh).not.toHaveBeenCalled();
        expect(isSocketRecovering()).toBe(true);
        expect(socketCrumbs().map((c) => c.message)).toContain('reauth required: reconnecting with stored token');
      });

      it('refreshes when the newer stored token has itself expired', async () => {
        const fake = makeFake();
        mockedIo.mockReturnValue(fake);
        mockedRefresh.mockResolvedValue({ status: 'ok', accessToken: 'fresh' });
        getSocket();
        connectWith(fake, jwt(Date.now() - 60_000));
        mockAccessToken = jwt(Date.now() - 1_000);

        await handleReauthRequired(fake as unknown as Parameters<typeof handleReauthRequired>[0]);

        expect(mockedRefresh).toHaveBeenCalledTimes(1);
      });

      it('stops recovering when the refresh token is rejected', async () => {
        const fake = makeFake();
        mockedIo.mockReturnValue(fake);
        mockedRefresh.mockResolvedValue({ status: 'rejected' });
        const socket = getSocket();

        await handleReauthRequired(socket);

        expect(isSocketRecovering()).toBe(false);
        expect(socketCrumbs().map((c) => c.message)).toContain('reauth abandoned: refresh rejected');
      });

      it('keeps recovering when the refresh is unavailable, leaving the retry to connect_error', async () => {
        const fake = makeFake();
        mockedIo.mockReturnValue(fake);
        mockedRefresh.mockResolvedValue({ status: 'unavailable' });
        const socket = getSocket();

        await handleReauthRequired(socket);

        expect(isSocketRecovering()).toBe(true);
        expect(fake.connect).not.toHaveBeenCalled();
      });

      it('ignores the signal for a socket that was reset (logout)', async () => {
        const fake = makeFake();
        mockedIo.mockReturnValue(fake);
        const socket = getSocket();
        resetSocket();

        await handleReauthRequired(socket);

        expect(mockedRefresh).not.toHaveBeenCalled();
        expect(isSocketRecovering()).toBe(false);
      });
    });
  });
});
