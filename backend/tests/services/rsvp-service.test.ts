/**
 * Unit tests for RsvpService
 *
 * Covers game existence, team-access gating, upsert shape, summary counts.
 */

import { RsvpService } from '../../src/services/rsvp-service';
import { mockPrisma } from '../setup';
import { createAdmin, createCoach, createGame } from '../factories';
import {
  expectForbiddenError,
  expectNotFoundError,
} from '../helpers';

function setNoAccess(): void {
  // canAccessTeam: user not admin, no league admin, no staff, no member
  (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(createCoach());
  (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(null);
  (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(null);
  (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);
}

function setAdminAccess(): void {
  // System admin short-circuits canAccessTeam to true
  (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(createAdmin());
}

describe('RsvpService', () => {
  describe('upsertRsvp', () => {
    it('throws NotFoundError when game does not exist', async () => {
      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await RsvpService.upsertRsvp('missing', 'user-1', 'YES');
        fail('expected to throw');
      } catch (err) {
        expectNotFoundError(err, 'Game not found');
      }
      expect(mockPrisma.gameRsvp.upsert).not.toHaveBeenCalled();
    });

    it('throws ForbiddenError when user lacks team access', async () => {
      const game = createGame();
      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
        id: game.id,
        teamId: game.teamId,
      });
      setNoAccess();

      try {
        await RsvpService.upsertRsvp(game.id, 'user-1', 'YES');
        fail('expected to throw');
      } catch (err) {
        expectForbiddenError(err, 'You do not have access to this team');
      }
      expect(mockPrisma.gameRsvp.upsert).not.toHaveBeenCalled();
    });

    it('upserts with the correct composite key and status', async () => {
      const game = createGame();
      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
        id: game.id,
        teamId: game.teamId,
      });
      setAdminAccess();
      const rsvpRow = {
        id: 'rsvp-1',
        gameId: game.id,
        userId: 'user-1',
        status: 'MAYBE',
        createdAt: new Date(),
        updatedAt: new Date(),
        user: { id: 'user-1', name: 'U', email: 'u@test.com' },
      };
      (mockPrisma.gameRsvp.upsert as jest.Mock).mockResolvedValue(rsvpRow);

      const result = await RsvpService.upsertRsvp(game.id, 'user-1', 'MAYBE');

      expect(result).toEqual(rsvpRow);
      expect(mockPrisma.gameRsvp.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { gameId_userId: { gameId: game.id, userId: 'user-1' } },
          create: { gameId: game.id, userId: 'user-1', status: 'MAYBE' },
          update: { status: 'MAYBE' },
        })
      );
    });
  });

  describe('getGameRsvps', () => {
    it('throws NotFoundError when game does not exist', async () => {
      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await RsvpService.getGameRsvps('missing', 'user-1');
        fail('expected to throw');
      } catch (err) {
        expectNotFoundError(err, 'Game not found');
      }
    });

    it('throws ForbiddenError when user lacks team access', async () => {
      const game = createGame();
      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
        id: game.id,
        teamId: game.teamId,
      });
      setNoAccess();

      try {
        await RsvpService.getGameRsvps(game.id, 'user-1');
        fail('expected to throw');
      } catch (err) {
        expectForbiddenError(err, 'You do not have access to this team');
      }
    });

    it('returns rsvps with summary counts derived from groupBy', async () => {
      const game = createGame();
      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
        id: game.id,
        teamId: game.teamId,
      });
      setAdminAccess();
      const rsvps = [
        { id: 'r1', gameId: game.id, userId: 'u1', status: 'YES' },
        { id: 'r2', gameId: game.id, userId: 'u2', status: 'NO' },
      ];
      (mockPrisma.gameRsvp.findMany as jest.Mock).mockResolvedValue(rsvps);
      (mockPrisma.gameRsvp.groupBy as jest.Mock).mockResolvedValue([
        { status: 'YES', _count: { status: 3 } },
        { status: 'NO', _count: { status: 1 } },
        { status: 'MAYBE', _count: { status: 2 } },
      ]);

      const result = await RsvpService.getGameRsvps(game.id, 'admin-1');

      expect(result.rsvps).toEqual(rsvps);
      expect(result.summary).toEqual({ yes: 3, no: 1, maybe: 2 });
    });

    it('defaults summary to zeros when there are no RSVPs', async () => {
      const game = createGame();
      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
        id: game.id,
        teamId: game.teamId,
      });
      setAdminAccess();
      (mockPrisma.gameRsvp.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.gameRsvp.groupBy as jest.Mock).mockResolvedValue([]);

      const result = await RsvpService.getGameRsvps(game.id, 'admin-1');

      expect(result.summary).toEqual({ yes: 0, no: 0, maybe: 0 });
      expect(result.rsvps).toEqual([]);
    });
  });

  describe('getUserRsvp', () => {
    it('delegates to findUnique with the composite key', async () => {
      const rsvp = {
        id: 'r1',
        gameId: 'g1',
        userId: 'u1',
        status: 'YES',
      };
      (mockPrisma.gameRsvp.findUnique as jest.Mock).mockResolvedValue(rsvp);

      const result = await RsvpService.getUserRsvp('g1', 'u1');

      expect(result).toBe(rsvp);
      expect(mockPrisma.gameRsvp.findUnique).toHaveBeenCalledWith({
        where: { gameId_userId: { gameId: 'g1', userId: 'u1' } },
      });
    });

    it('returns null when no rsvp exists', async () => {
      (mockPrisma.gameRsvp.findUnique as jest.Mock).mockResolvedValue(null);
      const result = await RsvpService.getUserRsvp('g1', 'u1');
      expect(result).toBeNull();
    });
  });
});
