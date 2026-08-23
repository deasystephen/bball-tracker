/**
 * Unit tests for RsvpService
 *
 * Covers game existence, team-access gating, upsert shape, summary counts.
 */

import { RsvpService } from '../../src/services/rsvp-service';
import { mockPrisma } from '../setup';
import { createAdmin, createCoach, createGame, createPlayer } from '../factories';
import {
  expectForbiddenError,
  expectNotFoundError,
} from '../helpers';

jest.mock('../../src/services/mailer', () => ({
  mailer: { send: jest.fn().mockResolvedValue({ messageId: 'fake' }) },
}));

const mockedMailerSend = (jest.requireMock('../../src/services/mailer') as unknown as { mailer: { send: jest.Mock } }).mailer.send;

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
        opponent: game.opponent,
        date: game.date,
        team: { name: 'Test Team' },
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

    it('does not surface email send failures to the caller', async () => {
      const game = createGame();
      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
        id: game.id,
        teamId: game.teamId,
        opponent: game.opponent,
        date: game.date,
        team: { name: 'Test Team' },
      });
      setAdminAccess();
      const rsvpRow = {
        id: 'rsvp-2',
        gameId: game.id,
        userId: 'user-1',
        status: 'YES',
        createdAt: new Date(),
        updatedAt: new Date(),
        user: { id: 'user-1', name: 'U', email: 'u@test.com' },
      };
      (mockPrisma.gameRsvp.upsert as jest.Mock).mockResolvedValue(rsvpRow);
      mockedMailerSend.mockRejectedValueOnce(new Error('SES down'));

      await expect(RsvpService.upsertRsvp(game.id, 'user-1', 'YES')).resolves.toEqual(rsvpRow);
      await Promise.resolve();
    });

    it('falls back to the email as playerName when the user has no name', async () => {
      const game = createGame();
      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
        id: game.id,
        teamId: game.teamId,
        opponent: game.opponent,
        date: game.date,
        team: { name: 'Test Team' },
      });
      setAdminAccess();
      const rsvpRow = {
        id: 'rsvp-3',
        gameId: game.id,
        userId: 'user-1',
        status: 'YES',
        createdAt: new Date(),
        updatedAt: new Date(),
        user: { id: 'user-1', name: null, email: 'noname@test.com' },
      };
      (mockPrisma.gameRsvp.upsert as jest.Mock).mockResolvedValue(rsvpRow);

      await RsvpService.upsertRsvp(game.id, 'user-1', 'YES');
      await Promise.resolve();

      expect(mockedMailerSend).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'noname@test.com',
          variables: expect.objectContaining({ playerName: 'noname@test.com' }),
        })
      );
    });

    it('formats gameDate in DEFAULT_TIMEZONE with the time, not the server zone (audit #57)', async () => {
      const previous = process.env.DEFAULT_TIMEZONE;
      process.env.DEFAULT_TIMEZONE = 'America/Los_Angeles';
      try {
        // 02:30Z on the 16th is still the evening of the 15th in Los Angeles.
        const game = createGame({ date: new Date('2026-03-16T02:30:00Z') });
        (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
          id: game.id,
          teamId: game.teamId,
          opponent: game.opponent,
          date: game.date,
          team: { name: 'Test Team' },
        });
        setAdminAccess();
        (mockPrisma.gameRsvp.upsert as jest.Mock).mockResolvedValue({
          id: 'rsvp-tz',
          gameId: game.id,
          userId: 'user-1',
          status: 'YES',
          createdAt: new Date(),
          updatedAt: new Date(),
          user: { id: 'user-1', name: 'Tz Tester', email: 'tz@test.com' },
        });

        await RsvpService.upsertRsvp(game.id, 'user-1', 'YES');
        await Promise.resolve();

        const call = mockedMailerSend.mock.calls.find(
          ([arg]: [{ to: string }]) => arg.to === 'tz@test.com'
        );
        expect(call).toBeDefined();
        expect(call![0].variables.gameDate).toMatch(/^Mar 15, 2026, 7:30/);
      } finally {
        if (previous === undefined) delete process.env.DEFAULT_TIMEZONE;
        else process.env.DEFAULT_TIMEZONE = previous;
      }
    });

    it('skips sending email when the user has no email address', async () => {
      const game = createGame();
      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
        id: game.id,
        teamId: game.teamId,
        opponent: game.opponent,
        date: game.date,
        team: { name: 'Test Team' },
      });
      setAdminAccess();
      const rsvpRow = {
        id: 'rsvp-4',
        gameId: game.id,
        userId: 'user-1',
        status: 'NO',
        createdAt: new Date(),
        updatedAt: new Date(),
        user: { id: 'user-1', name: 'NoEmail', email: null },
      };
      (mockPrisma.gameRsvp.upsert as jest.Mock).mockResolvedValue(rsvpRow);

      await RsvpService.upsertRsvp(game.id, 'user-1', 'NO');
      await Promise.resolve();

      expect(mockedMailerSend).not.toHaveBeenCalled();
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

    it('keeps every RSVP user email for a roster manager (admin)', async () => {
      const game = createGame();
      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({ id: game.id, teamId: game.teamId });
      setAdminAccess();
      (mockPrisma.gameRsvp.findMany as jest.Mock).mockResolvedValue([
        { id: 'r1', gameId: game.id, userId: 'u1', status: 'YES', user: { id: 'u1', name: 'A', email: 'a@test.com' } },
      ]);
      (mockPrisma.gameRsvp.groupBy as jest.Mock).mockResolvedValue([]);

      const result = await RsvpService.getGameRsvps(game.id, 'admin-1');

      expect(result.rsvps[0].user).toEqual({ id: 'u1', name: 'A', email: 'a@test.com' });
    });

    it('strips other users\' emails for a plain team member, keeping their own (role matrix B2.5)', async () => {
      const game = createGame();
      const player = createPlayer({ id: 'me' });
      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({ id: game.id, teamId: game.teamId });
      // canAccessTeam: member (not admin, not league admin, not staff)
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(player);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        id: game.teamId,
        season: { league: { admins: [] } },
      });
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue({ teamId: game.teamId, playerId: 'me' });
      // getTeamPermissions: no staff roles → view-only
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.gameRsvp.findMany as jest.Mock).mockResolvedValue([
        { id: 'r1', gameId: game.id, userId: 'me', status: 'YES', user: { id: 'me', name: 'Me', email: 'me@test.com' } },
        { id: 'r2', gameId: game.id, userId: 'u2', status: 'NO', user: { id: 'u2', name: 'Other', email: 'other@test.com' } },
      ]);
      (mockPrisma.gameRsvp.groupBy as jest.Mock).mockResolvedValue([]);

      const result = await RsvpService.getGameRsvps(game.id, 'me');

      expect(result.rsvps[0].user).toEqual({ id: 'me', name: 'Me', email: 'me@test.com' });
      expect(result.rsvps[1].user).toEqual({ id: 'u2', name: 'Other' });
      expect(JSON.stringify(result)).not.toContain('other@test.com');
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
