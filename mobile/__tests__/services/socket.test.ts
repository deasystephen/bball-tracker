/**
 * Tests for the socket.io-client singleton wrapper.
 */

import { io } from 'socket.io-client';

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

import { getSocket, resetSocket } from '../../services/socket';

const mockedIo = io as jest.Mock;

describe('socket wrapper', () => {
  beforeEach(() => {
    resetSocket();
    mockedIo.mockReset();
  });

  it('lazily constructs a single socket', () => {
    const fake = { removeAllListeners: jest.fn(), disconnect: jest.fn() };
    mockedIo.mockReturnValue(fake);

    const a = getSocket();
    const b = getSocket();

    expect(a).toBe(b);
    expect(mockedIo).toHaveBeenCalledTimes(1);
  });

  it('passes the configured base URL and websocket-only transport', () => {
    const fake = { removeAllListeners: jest.fn(), disconnect: jest.fn() };
    mockedIo.mockReturnValue(fake);

    getSocket();

    const [url, opts] = mockedIo.mock.calls[0];
    expect(url).toBe('http://test.local');
    expect(opts.transports).toEqual(['websocket']);
    expect(opts.reconnection).toBe(true);
  });

  it('supplies the current token via the auth callback on each call', () => {
    const fake = { removeAllListeners: jest.fn(), disconnect: jest.fn() };
    mockedIo.mockReturnValue(fake);

    getSocket();

    const opts = mockedIo.mock.calls[0][1];
    const cb = jest.fn();
    opts.auth(cb);
    expect(cb).toHaveBeenCalledWith({ token: 'tok_abc' });
  });

  it('resetSocket disconnects and allows a fresh build', () => {
    const fake = { removeAllListeners: jest.fn(), disconnect: jest.fn() };
    mockedIo.mockReturnValue(fake);

    getSocket();
    resetSocket();

    expect(fake.removeAllListeners).toHaveBeenCalled();
    expect(fake.disconnect).toHaveBeenCalled();

    const fresh = { removeAllListeners: jest.fn(), disconnect: jest.fn() };
    mockedIo.mockReturnValue(fresh);
    getSocket();
    expect(mockedIo).toHaveBeenCalledTimes(2);
  });
});
