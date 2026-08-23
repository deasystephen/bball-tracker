/**
 * Unit tests for the head-coach / staff-management permission helpers, the
 * distinct-team counter (role matrix B2.3 / B2.8) and getPlayerTeamAccess
 * (B2.4 / B2.10).
 */

import { isHeadCoach, canManageStaff, countDistinctStaffTeams, getPlayerTeamAccess } from '../../src/utils/permissions';
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

type MembershipRow = {
  teamId: string;
  team: { season: { league: { admins: { id: string }[] } }; staff: { id: string }[] };
};

const membership = (teamId: string, opts: { staff?: boolean; leagueAdmin?: boolean } = {}): MembershipRow => ({
  teamId,
  team: {
    season: { league: { admins: opts.leagueAdmin ? [{ id: 'la-1' }] : [] } },
    staff: opts.staff ? [{ id: 'staff-1' }] : [],
  },
});

describe('getPlayerTeamAccess', () => {
  it('returns empty lists for a player on no team without consulting the caller role', async () => {
    (mockPrisma.teamMember.findMany as jest.Mock).mockResolvedValue([]);

    const result = await getPlayerTeamAccess('coach-1', 'player-1');

    expect(result).toEqual({ memberTeamIds: [], manageableTeamIds: [] });
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.teamMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { playerId: 'player-1' } })
    );
  });

  it('skips the role lookup when the caller already manages every team', async () => {
    (mockPrisma.teamMember.findMany as jest.Mock).mockResolvedValue([membership('t-1', { staff: true })]);

    const result = await getPlayerTeamAccess('coach-1', 'player-1');

    expect(result.manageableTeamIds).toEqual(['t-1']);
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('includes teams where the caller is roster-managing staff or league admin', async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(createCoach());
    (mockPrisma.teamMember.findMany as jest.Mock).mockResolvedValue([
      membership('t-staff', { staff: true }),
      membership('t-league', { leagueAdmin: true }),
      membership('t-none'),
    ]);

    const result = await getPlayerTeamAccess('coach-1', 'player-1');

    expect(result.memberTeamIds).toEqual(['t-staff', 't-league', 't-none']);
    expect(result.manageableTeamIds).toEqual(['t-staff', 't-league']);
  });

  it('treats every team as manageable for a system ADMIN', async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(createAdmin());
    (mockPrisma.teamMember.findMany as jest.Mock).mockResolvedValue([membership('t-1'), membership('t-2')]);

    const result = await getPlayerTeamAccess('admin-1', 'player-1');

    expect(result.manageableTeamIds).toEqual(['t-1', 't-2']);
  });

  it('filters the caller into the staff / league-admin sub-queries', async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(createCoach());
    (mockPrisma.teamMember.findMany as jest.Mock).mockResolvedValue([membership('t-1')]);

    await getPlayerTeamAccess('coach-1', 'player-1');

    const args = (mockPrisma.teamMember.findMany as jest.Mock).mock.calls[0][0];
    expect(args.select.team.select.staff.where).toEqual({ userId: 'coach-1', role: { canManageRoster: true } });
    expect(args.select.team.select.season.select.league.select.admins.where).toEqual({ userId: 'coach-1' });
  });
});
