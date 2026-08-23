/**
 * Unit tests for the head-coach / staff-management permission helpers and the
 * distinct-team counter (role matrix B2.3 / B2.8).
 */

import { isHeadCoach, canManageStaff, countDistinctStaffTeams } from '../../src/utils/permissions';
import { mockPrisma } from '../setup';
import { createAdmin, createCoach, createTeam, createTeamStaff } from '../factories';

describe('permissions helpers', () => {
  describe('isHeadCoach', () => {
    it('returns true when the user has a HEAD_COACH-type staff row on the team', async () => {
      const coach = createCoach();
      const team = createTeam();
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue({ id: 'row' });

      await expect(isHeadCoach(coach.id, team.id)).resolves.toBe(true);
      expect(mockPrisma.teamStaff.findFirst).toHaveBeenCalledWith({
        where: { teamId: team.id, userId: coach.id, role: { type: 'HEAD_COACH' } },
        select: { id: true },
      });
    });

    it('returns false when no HEAD_COACH row exists (assistant coach, manager, outsider)', async () => {
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(isHeadCoach('u', 't')).resolves.toBe(false);
    });
  });

  describe('canManageStaff', () => {
    it('short-circuits true for a system ADMIN', async () => {
      const admin = createAdmin();
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);

      await expect(canManageStaff(admin.id, 't')).resolves.toBe(true);
      expect(mockPrisma.team.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.teamStaff.findFirst).not.toHaveBeenCalled();
    });

    it('returns true for an admin of the team\'s league', async () => {
      const user = createCoach();
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(user);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({ season: { leagueId: 'league-1' } });
      (mockPrisma.leagueAdmin.findUnique as jest.Mock).mockResolvedValue({ leagueId: 'league-1', userId: user.id });

      await expect(canManageStaff(user.id, 't')).resolves.toBe(true);
      expect(mockPrisma.leagueAdmin.findUnique).toHaveBeenCalledWith({
        where: { leagueId_userId: { leagueId: 'league-1', userId: user.id } },
      });
      expect(mockPrisma.teamStaff.findFirst).not.toHaveBeenCalled();
    });

    it('returns true for a head coach who is neither admin nor league admin', async () => {
      const user = createCoach();
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(user);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({ season: { leagueId: 'league-1' } });
      (mockPrisma.leagueAdmin.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(createTeamStaff());

      await expect(canManageStaff(user.id, 't')).resolves.toBe(true);
    });

    it('returns false for an assistant coach (no HEAD_COACH row)', async () => {
      const user = createCoach();
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(user);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({ season: { leagueId: 'league-1' } });
      (mockPrisma.leagueAdmin.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(canManageStaff(user.id, 't')).resolves.toBe(false);
    });

    it('skips the league-admin lookup when the team does not exist and falls through to the staff check', async () => {
      const user = createCoach();
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(user);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(canManageStaff(user.id, 'missing')).resolves.toBe(false);
      expect(mockPrisma.leagueAdmin.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('countDistinctStaffTeams', () => {
    it('queries distinct teamIds for the user and returns how many', async () => {
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([
        { teamId: 'a' },
        { teamId: 'b' },
      ]);

      await expect(countDistinctStaffTeams('u')).resolves.toBe(2);
      expect(mockPrisma.teamStaff.findMany).toHaveBeenCalledWith({
        where: { userId: 'u' },
        distinct: ['teamId'],
        select: { teamId: true },
      });
    });

    it('uses the supplied transaction client', async () => {
      const tx = { teamStaff: { findMany: jest.fn().mockResolvedValue([{ teamId: 'a' }]) } };

      await expect(
        countDistinctStaffTeams('u', tx as unknown as Parameters<typeof countDistinctStaffTeams>[1])
      ).resolves.toBe(1);
      expect(tx.teamStaff.findMany).toHaveBeenCalled();
      expect(mockPrisma.teamStaff.findMany).not.toHaveBeenCalled();
    });

    it('returns 0 for a user with no staff rows', async () => {
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([]);

      await expect(countDistinctStaffTeams('u')).resolves.toBe(0);
    });
  });
});
