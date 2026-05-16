/**
 * Tests for the useLiveGame hook.
 */

import { renderHook, act } from '@testing-library/react-native';

interface AckFn {
  (response: { success: boolean; gameId?: string; error?: string; code?: string }): void;
}

interface FakeSocket {
  connected: boolean;
  handlers: Record<string, ((...args: unknown[]) => void)[]>;
  emitCalls: Array<{ event: string; payload: unknown; ack?: AckFn }>;
  on: jest.Mock;
  off: jest.Mock;
  emit: jest.Mock;
  connect: jest.Mock;
  fire: (event: string, ...args: unknown[]) => void;
}

const createFakeSocket = (): FakeSocket => {
  const socket: FakeSocket = {
    connected: true,
    handlers: {},
    emitCalls: [],
    on: jest.fn(),
    off: jest.fn(),
    emit: jest.fn(),
    connect: jest.fn(),
    fire: (event, ...args) => {
      (socket.handlers[event] ?? []).forEach((h) => h(...args));
    },
  };

  socket.on.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
    socket.handlers[event] = [...(socket.handlers[event] ?? []), handler];
    return socket;
  });
  socket.off.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
    socket.handlers[event] = (socket.handlers[event] ?? []).filter((h) => h !== handler);
    return socket;
  });
  socket.emit.mockImplementation((event: string, payload: unknown, ack?: AckFn) => {
    socket.emitCalls.push({ event, payload, ack });
    if (event === 'join-game' && ack) ack({ success: true, gameId: 'g1' });
    return socket;
  });

  return socket;
};

let mockSocket: FakeSocket;

jest.mock('../../services/socket', () => ({
  getSocket: jest.fn(() => mockSocket),
}));

import { useLiveGame } from '../../hooks/useLiveGame';

const makeEvent = (id: string, gameId = 'g1') => ({
  id,
  gameId,
  eventType: 'SHOT' as const,
  timestamp: '2026-05-16T10:00:00Z',
  metadata: { made: true, points: 2 } as const,
  createdAt: '2026-05-16T10:00:00Z',
});

describe('useLiveGame', () => {
  beforeEach(() => {
    mockSocket = createFakeSocket();
  });

  it('emits join-game with the gameId on mount', () => {
    renderHook(() => useLiveGame('g1'));
    const join = mockSocket.emitCalls.find((c) => c.event === 'join-game');
    expect(join).toBeDefined();
    expect(join?.payload).toEqual({ gameId: 'g1' });
  });

  it('applies snapshot: score, status, events reversed to newest-first', () => {
    const { result } = renderHook(() => useLiveGame('g1'));

    act(() => {
      mockSocket.fire('game-snapshot', {
        game: {
          id: 'g1',
          teamId: 't1',
          opponent: 'Rivals',
          date: '2026-05-16T10:00:00Z',
          status: 'IN_PROGRESS',
          homeScore: 4,
          awayScore: 2,
        },
        // Server sends chronologically (oldest first); hook should reverse.
        events: [makeEvent('e1'), makeEvent('e2'), makeEvent('e3')],
      });
    });

    expect(result.current.score).toEqual({ homeScore: 4, awayScore: 2 });
    expect(result.current.status).toBe('IN_PROGRESS');
    expect(result.current.connectionState).toBe('live');
    expect(result.current.events.map((e) => e.id)).toEqual(['e3', 'e2', 'e1']);
  });

  it('appends game-event newest-first and updates score', () => {
    const { result } = renderHook(() => useLiveGame('g1'));

    act(() => {
      mockSocket.fire('game-snapshot', {
        game: {
          id: 'g1',
          teamId: 't1',
          opponent: 'Rivals',
          date: '2026-05-16T10:00:00Z',
          status: 'IN_PROGRESS',
          homeScore: 0,
          awayScore: 0,
        },
        events: [makeEvent('e1')],
      });
    });

    act(() => {
      mockSocket.fire('game-event', {
        event: makeEvent('e2'),
        score: { homeScore: 2, awayScore: 0 },
      });
    });

    expect(result.current.score).toEqual({ homeScore: 2, awayScore: 0 });
    expect(result.current.events.map((e) => e.id)).toEqual(['e2', 'e1']);
  });

  it('dedupes events by id when the same id arrives twice', () => {
    const { result } = renderHook(() => useLiveGame('g1'));

    act(() => {
      mockSocket.fire('game-snapshot', {
        game: {
          id: 'g1',
          teamId: 't1',
          opponent: 'Rivals',
          date: '2026-05-16T10:00:00Z',
          status: 'IN_PROGRESS',
          homeScore: 0,
          awayScore: 0,
        },
        events: [makeEvent('e1')],
      });
    });

    act(() => {
      mockSocket.fire('game-event', {
        event: makeEvent('e1'),
        score: { homeScore: 2, awayScore: 0 },
      });
    });

    // Event list unchanged in length, but score still applied.
    expect(result.current.events.map((e) => e.id)).toEqual(['e1']);
    expect(result.current.score).toEqual({ homeScore: 2, awayScore: 0 });
  });

  it('applies game-status-change', () => {
    const { result } = renderHook(() => useLiveGame('g1'));

    act(() => {
      mockSocket.fire('game-snapshot', {
        game: {
          id: 'g1',
          teamId: 't1',
          opponent: 'Rivals',
          date: '2026-05-16T10:00:00Z',
          status: 'IN_PROGRESS',
          homeScore: 10,
          awayScore: 8,
        },
        events: [],
      });
    });

    act(() => {
      mockSocket.fire('game-status-change', {
        gameId: 'g1',
        previousStatus: 'IN_PROGRESS',
        status: 'FINISHED',
        score: { homeScore: 10, awayScore: 8 },
      });
    });

    expect(result.current.status).toBe('FINISHED');
  });

  it('re-emits join-game on reconnect', () => {
    renderHook(() => useLiveGame('g1'));

    const joinsBefore = mockSocket.emitCalls.filter((c) => c.event === 'join-game').length;
    expect(joinsBefore).toBe(1);

    act(() => {
      mockSocket.fire('disconnect', 'transport close');
      mockSocket.fire('connect');
    });

    const joinsAfter = mockSocket.emitCalls.filter((c) => c.event === 'join-game').length;
    expect(joinsAfter).toBe(2);
  });

  it('emits leave-game on unmount and detaches listeners', () => {
    const { unmount } = renderHook(() => useLiveGame('g1'));

    unmount();

    const leave = mockSocket.emitCalls.find((c) => c.event === 'leave-game');
    expect(leave).toBeDefined();
    expect(leave?.payload).toEqual({ gameId: 'g1' });

    // Every on() should have been paired with an off().
    expect(mockSocket.off).toHaveBeenCalledTimes(mockSocket.on.mock.calls.length);
  });

  it('does nothing when gameId is undefined', () => {
    renderHook(() => useLiveGame(undefined));
    expect(mockSocket.emit).not.toHaveBeenCalled();
  });
});
