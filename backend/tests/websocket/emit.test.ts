/**
 * Unit tests for the emit helpers — verify that when Socket.io is registered,
 * helpers target the correct room; and when no server is registered they
 * silently no-op instead of throwing.
 */

import { emitGameEvent, emitGameStatusChange } from '../../src/websocket/emit';
import { setIo } from '../../src/websocket/io-registry';
import { gameRoom } from '../../src/websocket/game-events';
import type { Server as SocketServer } from 'socket.io';
import type { GameEvent, GameStatus } from '@prisma/client';

interface FakeIo {
  io: SocketServer;
  emit: jest.Mock;
  to: jest.Mock;
}

function makeFakeIo(): FakeIo {
  const emit = jest.fn();
  const to = jest.fn().mockReturnValue({ emit });
  return { io: { to } as unknown as SocketServer, emit, to };
}

function makeFakeEvent(): GameEvent {
  return {
    id: 'evt-1',
    gameId: 'game-1',
    playerId: null,
    eventType: 'SHOT',
    timestamp: new Date(),
    metadata: {},
    createdAt: new Date(),
  } as unknown as GameEvent;
}

describe('websocket/emit', () => {
  afterEach(() => {
    setIo(null);
  });

  describe('emitGameEvent', () => {
    it('no-ops when no Socket.io server is registered', () => {
      expect(() => emitGameEvent('game-1', {
        event: makeFakeEvent(),
        score: { homeScore: 0, awayScore: 0 },
      })).not.toThrow();
    });

    it('broadcasts to the game room with the event payload', () => {
      const { io, to, emit } = makeFakeIo();
      setIo(io);

      const event = makeFakeEvent();
      emitGameEvent('game-1', { event, score: { homeScore: 4, awayScore: 2 } });

      expect(to).toHaveBeenCalledWith(gameRoom('game-1'));
      expect(emit).toHaveBeenCalledWith('game-event', {
        event,
        score: { homeScore: 4, awayScore: 2 },
      });
    });

    it('swallows errors from the underlying socket server', () => {
      const to = jest.fn(() => {
        throw new Error('boom');
      });
      setIo({ to } as unknown as SocketServer);
      expect(() =>
        emitGameEvent('game-1', {
          event: makeFakeEvent(),
          score: { homeScore: 0, awayScore: 0 },
        })
      ).not.toThrow();
    });
  });

  describe('emitGameStatusChange', () => {
    it('broadcasts a status-change payload to the game room', () => {
      const { io, to, emit } = makeFakeIo();
      setIo(io);

      const payload = {
        gameId: 'game-1',
        previousStatus: 'SCHEDULED' as GameStatus,
        status: 'IN_PROGRESS' as GameStatus,
        score: { homeScore: 0, awayScore: 0 },
      };
      emitGameStatusChange('game-1', payload);

      expect(to).toHaveBeenCalledWith(gameRoom('game-1'));
      expect(emit).toHaveBeenCalledWith('game-status-change', payload);
    });

    it('no-ops when no Socket.io server is registered', () => {
      expect(() =>
        emitGameStatusChange('game-1', {
          gameId: 'game-1',
          previousStatus: 'SCHEDULED',
          status: 'IN_PROGRESS',
          score: { homeScore: 0, awayScore: 0 },
        })
      ).not.toThrow();
    });
  });
});
