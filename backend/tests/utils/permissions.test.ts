/**
 * Unit tests for utils/permissions getPlayerTeamAccess
 */

import { getPlayerTeamAccess } from '../../src/utils/permissions';
import { mockPrisma } from '../setup';
import { createAdmin, createCoach } from '../factories';

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
