/**
 * Unit tests for the head-coach / staff-management permission helpers, the
 * distinct-team counter (role matrix B2.3 / B2.8), getPlayerTeamAccess
 * (B2.4 / B2.10) and the guardian (PARENT role) branches.
 */

import {
  isHeadCoach,
  canManageStaff,
  countDistinctStaffTeams,
  getPlayerTeamAccess,
  canAccessTeam,
  getTeamPermissions,
  isGuardianOf,
  isGuardianOfTeamMember,
  teamAccessWhere,
  canWriteLeague,
  getGuardianChildIds,
} from '../../src/utils/permissions';
import { mockPrisma } from '../setup';
import {
  createAdmin,
  createCoach,
  createPlayer,
  createTeam,
  createTeamStaff,
  createUser,
} from '../factories';

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
// ---------------------------------------------------------------------------
// Guardian (PARENT role) branches — docs/plans/parent-role-spec.md
// ---------------------------------------------------------------------------

const TEAM_ID = 'b2c3d4e5-f6a7-4901-a345-67890abcdef0';

function setPlainUser(): void {
  (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(createUser({ role: 'PARENT' }));
  (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
    ...createTeam({ id: TEAM_ID }),
    season: { league: { admins: [] } },
  });
  (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([]);
  (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(null);
  (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);
}

describe('permissions — guardian branches', () => {
  describe('isGuardianOf', () => {
    it('is true when a Guardian row links parent and child', async () => {
      (mockPrisma.guardian.findUnique as jest.Mock).mockResolvedValue({ id: 'g-1' });

      expect(await isGuardianOf('parent-1', 'child-1')).toBe(true);
      expect(mockPrisma.guardian.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { parentId_childId: { parentId: 'parent-1', childId: 'child-1' } } })
      );
    });

    it('is false otherwise', async () => {
      (mockPrisma.guardian.findUnique as jest.Mock).mockResolvedValue(null);
      expect(await isGuardianOf('parent-1', 'child-1')).toBe(false);
    });
  });

  describe('isGuardianOfTeamMember', () => {
    it('queries for a guardian link whose child is rostered on the team', async () => {
      (mockPrisma.guardian.findFirst as jest.Mock).mockResolvedValue({ id: 'g-1' });

      expect(await isGuardianOfTeamMember('parent-1', TEAM_ID)).toBe(true);
      expect(mockPrisma.guardian.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { parentId: 'parent-1', child: { teamMembers: { some: { teamId: TEAM_ID } } } },
        })
      );
    });

    it('is false when no child is on the team', async () => {
      (mockPrisma.guardian.findFirst as jest.Mock).mockResolvedValue(null);
      expect(await isGuardianOfTeamMember('parent-1', TEAM_ID)).toBe(false);
    });
  });

  describe('canAccessTeam', () => {
    it('grants access to a guardian of a current member', async () => {
      setPlainUser();
      (mockPrisma.guardian.findFirst as jest.Mock).mockResolvedValue({ id: 'g-1' });

      expect(await canAccessTeam('parent-1', TEAM_ID)).toBe(true);
    });

    it('denies access when the user is neither staff, member nor guardian', async () => {
      setPlainUser();
      (mockPrisma.guardian.findFirst as jest.Mock).mockResolvedValue(null);

      expect(await canAccessTeam('stranger', TEAM_ID)).toBe(false);
    });

    it('does not consult guardian links for a rostered member', async () => {
      setPlainUser();
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue({ id: 'm-1' });

      expect(await canAccessTeam('player-1', TEAM_ID)).toBe(true);
      expect(mockPrisma.guardian.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('getTeamPermissions', () => {
    it('returns canViewStats only for a guardian with no staff row', async () => {
      setPlainUser();
      (mockPrisma.guardian.findFirst as jest.Mock).mockResolvedValue({ id: 'g-1' });

      expect(await getTeamPermissions('parent-1', TEAM_ID)).toEqual({
        canManageTeam: false,
        canManageRoster: false,
        canTrackStats: false,
        canViewStats: true,
        canShareStats: false,
      });
    });

    it('returns no permissions for a non-guardian non-member', async () => {
      setPlainUser();
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(createPlayer());
      (mockPrisma.guardian.findFirst as jest.Mock).mockResolvedValue(null);

      expect(await getTeamPermissions('stranger', TEAM_ID)).toEqual({
        canManageTeam: false,
        canManageRoster: false,
        canTrackStats: false,
        canViewStats: false,
        canShareStats: false,
      });
    });

    it('a guardian who is also staff gets the staff role permissions', async () => {
      setPlainUser();
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([
        { role: { canManageTeam: false, canManageRoster: false, canTrackStats: true, canViewStats: true, canShareStats: true } },
      ]);

      const perms = await getTeamPermissions('parent-coach', TEAM_ID);

      expect(perms.canTrackStats).toBe(true);
      expect(mockPrisma.guardian.findFirst).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // League write access (#442). The READ side ships with #443.
  // -----------------------------------------------------------------------
  describe('getGuardianChildIds', () => {
    it('maps the guardian links to child ids', async () => {
      (mockPrisma.guardian.findMany as jest.Mock).mockResolvedValue([
        { childId: 'kid-1' },
        { childId: 'kid-2' },
      ]);

      await expect(getGuardianChildIds('parent-1')).resolves.toEqual(['kid-1', 'kid-2']);
    });

    it('tolerates a client that returns undefined', async () => {
      (mockPrisma.guardian.findMany as jest.Mock).mockResolvedValue(undefined);

      await expect(getGuardianChildIds('parent-1')).resolves.toEqual([]);
    });
  });

  describe('teamAccessWhere', () => {
    it('covers staff, member and league admin, and omits the guardian branch when there are no children', () => {
      const where = teamAccessWhere('user-1', []);

      expect(where.OR).toHaveLength(3);
      expect(where.OR).toEqual([
        { staff: { some: { userId: 'user-1' } } },
        { members: { some: { playerId: 'user-1' } } },
        { season: { league: { admins: { some: { userId: 'user-1' } } } } },
      ]);
    });

    it('adds the guardian branch when the caller has children', () => {
      const where = teamAccessWhere('parent-1', ['kid-1']);

      expect(where.OR).toHaveLength(4);
      expect(where.OR?.[3]).toEqual({ members: { some: { playerId: { in: ['kid-1'] } } } });
    });
  });

  describe('canWriteLeague', () => {
    function notAdmin(): void {
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(createCoach());
    }

    it('is true for an admin of that league', async () => {
      notAdmin();
      (mockPrisma.leagueAdmin.findUnique as jest.Mock).mockResolvedValue({ id: 'la-1' });

      await expect(canWriteLeague('user-1', 'league-1')).resolves.toBe(true);
      // Short-circuits: no further probes.
      expect(mockPrisma.league.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.team.count).not.toHaveBeenCalled();
    });

    it('is true for a system ADMIN', async () => {
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(createAdmin());

      await expect(canWriteLeague('admin-1', 'league-1')).resolves.toBe(true);
    });

    it('is true for the personal-league owner', async () => {
      notAdmin();
      (mockPrisma.leagueAdmin.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.league.findUnique as jest.Mock).mockResolvedValue({ personalOwnerId: 'user-1' });

      await expect(canWriteLeague('user-1', 'league-1')).resolves.toBe(true);
      expect(mockPrisma.team.count).not.toHaveBeenCalled();
    });

    it('is true for staff on a team in the league', async () => {
      notAdmin();
      (mockPrisma.leagueAdmin.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.league.findUnique as jest.Mock).mockResolvedValue({ personalOwnerId: null });
      (mockPrisma.team.count as jest.Mock).mockResolvedValue(1);

      await expect(canWriteLeague('user-1', 'league-1')).resolves.toBe(true);
      expect(mockPrisma.team.count).toHaveBeenCalledWith({
        where: { season: { leagueId: 'league-1' }, staff: { some: { userId: 'user-1' } } },
      });
    });

    // The load-bearing case: a MEMBER of a team inside somebody's personal
    // league must not be able to plant a team in it. This is why the write set
    // is not the read set.
    it('is false for a mere member of a team in the league', async () => {
      notAdmin();
      (mockPrisma.leagueAdmin.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.league.findUnique as jest.Mock).mockResolvedValue({ personalOwnerId: 'someone-else' });
      (mockPrisma.team.count as jest.Mock).mockResolvedValue(0);

      await expect(canWriteLeague('member-1', 'league-1')).resolves.toBe(false);
    });
  });
});
