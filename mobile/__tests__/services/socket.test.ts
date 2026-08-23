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
  isSocketRecovering,
  MAX_AUTH_REFRESHES,
  MAX_UNAVAILABLE_RETRIES,
  BASE_BACKOFF_MS,
} from '../../services/socket';
import { refreshAccessToken } from '../../services/api-client';

jest.mock('socket.io-client', () => ({
  io: jest.fn(),
}));

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { extra: { apiUrl: 'http://test.local' } } },
}));

jest.mock('../../store/auth-store', () => ({
  useAuthStore: {
    getState: jest.fn(() => ({ accessToken: 'tok_abc' })),
  },
}));

// jest.setup.js mocks api-client without refreshAccessToken; add it here.
jest.mock('../../services/api-client', () => ({
  apiClient: { get: jest.fn(), post: jest.fn() },
  refreshAccessToken: jest.fn(),
}));

const mockedIo = io as jest.Mock;
const mockedRefresh = refreshAccessToken as jest.Mock;

interface FakeSocket {
  handlers: Record<string, ((...args: unknown[]) => void)[]>;
  on: jest.Mock;
  removeAllListeners: jest.Mock;
  disconnect: jest.Mock;
  connect: jest.Mock;
  fire: (event: string, ...args: unknown[]) => void;
}

const makeFake = (): FakeSocket => {
  const fake: FakeSocket = {
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
    mockedIo.mockReset();
    mockedRefresh.mockReset();
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
});
