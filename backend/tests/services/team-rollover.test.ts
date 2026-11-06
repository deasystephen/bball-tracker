/**
 * Unit tests for `TeamService.rolloverTeam` (#461, season rollover).
 *
 * The permission helpers are spied so each test states the caller's standing
 * directly; the real Postgres behaviour (unique index, lineage lock, career
 * view) is in `tests/integration/team-rollover.db.test.ts`.
 */

jest.mock('../../src/services/usage-service', () => ({
  ...jest.requireActual('../../src/services/usage-service'),
  invalidateUsage: jest.fn().mockResolvedValue(undefined),
}));

import * as permissions from '../../src/utils/permissions';
import { invalidateUsage } from '../../src/services/usage-service';
import { TeamService, SEASON_SIBLING_MESSAGE } from '../../src/services/team-service';
import { domainEvent, spyOnInfo } from '../support/domain-events';
import { mockPrisma } from '../setup';
import { uniqueViolation } from '../factories';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../src/utils/errors';

const USER = 'a1b2c3d4-e5f6-4890-a234-567890abcdef';
const ASSISTANT = 'b1b2c3d4-e5f6-4890-a234-567890abcdef';
const TEAM = 'c1b2c3d4-e5f6-4890-a234-567890abcdef';
const NEW_TEAM = 'd1b2c3d4-e5f6-4890-a234-567890abcdef';
const LINEAGE = 'e1b2c3d4-e5f6-4890-a234-567890abcdef';
const LEAGUE = 'f1b2c3d4-e5f6-4890-a234-567890abcdef';
const SEASON = 'a2b2c3d4-e5f6-4890-a234-567890abcdef';
const NEXT_SEASON = 'a3b2c3d4-e5f6-4890-a234-567890abcdef';
const PLAYER = 'a4b2c3d4-e5f6-4890-a234-567890abcdef';

const SOURCE = {
  id: TEAM,
  name: 'Hawks',
  seasonId: SEASON,
  lineageId: LINEAGE,
  chatLink: 'https://chat.example.test/hawks',
  ageGroup: 'U12',
  gender: 'GIRLS',
  season: { leagueId: LEAGUE },
};

const HEAD_ROLE = {
  type: 'HEAD_COACH',
  name: 'Head Coach',
  description: null,
  canManageTeam: true,
  canManageRoster: true,
  canTrackStats: true,
  canViewStats: true,
  canShareStats: true,
};
const CUSTOM_ROLE = { ...HEAD_ROLE, type: 'CUSTOM', name: 'Scorekeeper', canManageTeam: false, canManageRoster: false };

let canManageStaff: jest.SpyInstance;
let canWriteLeague: jest.SpyInstance;
let isLeagueAdmin: jest.SpyInstance;

/**
 * Routes `team.findUnique` by query shape: the source read (`select`), the
 * sibling probe (`lineageId_seasonId`) and the final read (`include`).
 */
function mockTeamReads(sibling: { id: string } | null = null): void {
  (mockPrisma.team.findUnique as jest.Mock).mockImplementation(
    (args: { where: Record<string, unknown>; include?: unknown }) => {
      if (args.where.lineageId_seasonId) return Promise.resolve(sibling);
      if (args.include) return Promise.resolve({ id: args.where.id, seasonId: NEXT_SEASON, staff: [], members: [] });
      return Promise.resolve(SOURCE);
    }
  );
}

function mockCopies(): void {
  (mockPrisma.team.create as jest.Mock).mockResolvedValue({ id: NEW_TEAM });
  (mockPrisma.teamRole.findMany as jest.Mock).mockImplementation((args: { where: { teamId: string } }) =>
    Promise.resolve(
      args.where.teamId === TEAM
        ? [HEAD_ROLE, CUSTOM_ROLE]
        : [
            { id: 'new-head', name: 'Head Coach' },
            { id: 'new-custom', name: 'Scorekeeper' },
          ]
    )
  );
  (mockPrisma.teamRole.createMany as jest.Mock).mockResolvedValue({ count: 2 });
  (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([
    { userId: USER, role: { name: 'Head Coach' } },
    { userId: ASSISTANT, role: { name: 'Scorekeeper' } },
  ]);
  (mockPrisma.teamStaff.createMany as jest.Mock).mockResolvedValue({ count: 2 });
  (mockPrisma.teamMember.findMany as jest.Mock).mockResolvedValue([
    { playerId: PLAYER, jerseyNumber: 0, position: 'PG' },
  ]);
  (mockPrisma.teamMember.createMany as jest.Mock).mockResolvedValue({ count: 1 });
}

beforeEach(() => {
  canManageStaff = jest.spyOn(permissions, 'canManageStaff').mockResolvedValue(true);
  canWriteLeague = jest.spyOn(permissions, 'canWriteLeague').mockResolvedValue(true);
  isLeagueAdmin = jest.spyOn(permissions, 'isLeagueAdmin').mockResolvedValue(true);
  mockTeamReads();
  mockCopies();
  (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue(null);
  (mockPrisma.season.upsert as jest.Mock).mockResolvedValue({ id: NEXT_SEASON });
});

afterEach(() => {
  canManageStaff.mockRestore();
  canWriteLeague.mockRestore();
  isLeagueAdmin.mockRestore();
});

describe('TeamService.rolloverTeam', () => {
  it('creates a new team-season on the same lineage and copies roles, staff and roster in one transaction', async () => {
    const info = spyOnInfo();

    const result = await TeamService.rolloverTeam(TEAM, { seasonName: '2027', ageGroup: 'U13' }, USER);

    expect(result).toEqual({ team: expect.objectContaining({ id: NEW_TEAM }), created: true });
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);

    // The lineage lock is the transaction's first statement.
    const [strings, ...values] = (mockPrisma.$queryRaw as jest.Mock).mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(strings.join('?')).toContain('FROM "TeamLineage"');
    expect(strings.join('?')).toContain('FOR NO KEY UPDATE');
    expect(values).toEqual([LINEAGE]);

    expect(mockPrisma.season.upsert).toHaveBeenCalledWith({
      where: { leagueId_name: { leagueId: LEAGUE, name: '2027' } },
      create: { leagueId: LEAGUE, name: '2027', isActive: true },
      update: { name: '2027' },
      select: { id: true },
    });
    expect(mockPrisma.team.create).toHaveBeenCalledWith({
      data: {
        name: 'Hawks',
        seasonId: NEXT_SEASON,
        lineageId: LINEAGE,
        chatLink: SOURCE.chatLink,
        ageGroup: 'U13',
        gender: 'GIRLS',
      },
      select: { id: true },
    });
    expect(mockPrisma.teamRole.createMany).toHaveBeenCalledWith({
      data: [
        { ...HEAD_ROLE, teamId: NEW_TEAM },
        { ...CUSTOM_ROLE, teamId: NEW_TEAM },
      ],
    });
    expect(mockPrisma.teamStaff.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { teamId: TEAM, user: { deletedAt: null } } })
    );
    expect(mockPrisma.teamStaff.createMany).toHaveBeenCalledWith({
      data: [
        { teamId: NEW_TEAM, userId: USER, roleId: 'new-head' },
        { teamId: NEW_TEAM, userId: ASSISTANT, roleId: 'new-custom' },
      ],
    });
    expect(mockPrisma.teamMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { teamId: TEAM, player: { deletedAt: null } } })
    );
    expect(mockPrisma.teamMember.createMany).toHaveBeenCalledWith({
      data: [{ teamId: NEW_TEAM, playerId: PLAYER, jerseyNumber: 0, position: 'PG' }],
    });

    // Nothing season-bound is carried, and the source row is never written.
    expect(mockPrisma.team.update).not.toHaveBeenCalled();
    expect(mockPrisma.teamInvitation.create).not.toHaveBeenCalled();
    expect(mockPrisma.calendarFeedToken.create).not.toHaveBeenCalled();
    expect(mockPrisma.announcement.create).not.toHaveBeenCalled();

    expect(domainEvent(info, 'Team rolled over')).toEqual({
      teamId: NEW_TEAM,
      fromTeamId: TEAM,
      lineageId: LINEAGE,
      fromSeasonId: SEASON,
      toSeasonId: NEXT_SEASON,
      created: true,
      seasonUpserted: true,
      members: 1,
      staff: 2,
      userId: USER,
    });
    expect(invalidateUsage).toHaveBeenCalledWith(USER, USER, ASSISTANT);
  });

  it('carries the bracket and name unchanged when the body leaves them out, and clears on null', async () => {
    (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue({ id: NEXT_SEASON, leagueId: LEAGUE });

    await TeamService.rolloverTeam(TEAM, { seasonId: NEXT_SEASON, name: 'Hawks 2027', gender: null }, USER);

    expect(mockPrisma.season.upsert).not.toHaveBeenCalled();
    expect(mockPrisma.team.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ name: 'Hawks 2027', seasonId: NEXT_SEASON, ageGroup: 'U12', gender: null }),
      select: { id: true },
    });
  });

  it('skips the staff and roster inserts when there is nothing to carry', async () => {
    (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.teamMember.findMany as jest.Mock).mockResolvedValue([]);

    await TeamService.rolloverTeam(TEAM, { seasonName: '2027' }, USER);

    expect(mockPrisma.teamStaff.createMany).not.toHaveBeenCalled();
    expect(mockPrisma.teamMember.createMany).not.toHaveBeenCalled();
  });

  it('drops a staff row whose role did not come across', async () => {
    (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([
      { userId: USER, role: { name: 'Head Coach' } },
      { userId: ASSISTANT, role: { name: 'Vanished' } },
    ]);

    await TeamService.rolloverTeam(TEAM, { seasonName: '2027' }, USER);

    expect(mockPrisma.teamStaff.createMany).toHaveBeenCalledWith({
      data: [{ teamId: NEW_TEAM, userId: USER, roleId: 'new-head' }],
    });
  });

  it('returns the existing row with created: false when the lineage already has one in that season', async () => {
    mockTeamReads({ id: NEW_TEAM });
    (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue({ id: NEXT_SEASON });
    const info = spyOnInfo();

    const result = await TeamService.rolloverTeam(TEAM, { seasonName: '2027' }, USER);

    expect(result).toEqual({ team: expect.objectContaining({ id: NEW_TEAM }), created: false });
    expect(mockPrisma.season.upsert).not.toHaveBeenCalled();
    expect(mockPrisma.team.create).not.toHaveBeenCalled();
    expect(mockPrisma.teamRole.createMany).not.toHaveBeenCalled();
    expect(invalidateUsage).not.toHaveBeenCalled();
    expect(domainEvent(info, 'Team rolled over')).toEqual(
      expect.objectContaining({ teamId: NEW_TEAM, created: false, seasonUpserted: false, members: 0, staff: 0 })
    );
  });

  it('reuses a season of that name without needing league admin', async () => {
    (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue({ id: NEXT_SEASON });
    isLeagueAdmin.mockResolvedValue(false);

    await TeamService.rolloverTeam(TEAM, { seasonName: '2027' }, USER);

    expect(isLeagueAdmin).not.toHaveBeenCalled();
    expect(mockPrisma.season.upsert).not.toHaveBeenCalled();
    expect(mockPrisma.team.create).toHaveBeenCalled();
  });

  describe('refusals', () => {
    it('404s an unknown team', async () => {
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(TeamService.rolloverTeam(TEAM, { seasonName: '2027' }, USER)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('403s a caller who cannot manage staff (an assistant coach), before reading any season', async () => {
      canManageStaff.mockResolvedValue(false);
      await expect(TeamService.rolloverTeam(TEAM, { seasonName: '2027' }, ASSISTANT)).rejects.toBeInstanceOf(
        ForbiddenError
      );
      expect(mockPrisma.season.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('403s creating a new season without league admin', async () => {
      isLeagueAdmin.mockResolvedValue(false);
      await expect(TeamService.rolloverTeam(TEAM, { seasonName: '2027' }, USER)).rejects.toThrow(
        'You do not have permission to create seasons for this league'
      );
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('403s a caller who cannot write the league', async () => {
      canWriteLeague.mockResolvedValue(false);
      await expect(TeamService.rolloverTeam(TEAM, { seasonName: '2027' }, USER)).rejects.toBeInstanceOf(
        ForbiddenError
      );
      expect(canWriteLeague).toHaveBeenCalledWith(USER, LEAGUE);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('404s an unknown seasonId', async () => {
      await expect(TeamService.rolloverTeam(TEAM, { seasonId: NEXT_SEASON }, USER)).rejects.toBeInstanceOf(
        NotFoundError
      );
    });

    it("400s a season in another league (that is adoption, #459)", async () => {
      (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue({ id: NEXT_SEASON, leagueId: 'other-league' });
      await expect(TeamService.rolloverTeam(TEAM, { seasonId: NEXT_SEASON }, USER)).rejects.toThrow(
        "The next season must be in this team's league"
      );
    });

    it("400s the team's own season", async () => {
      (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue({ id: SEASON, leagueId: LEAGUE });
      await expect(TeamService.rolloverTeam(TEAM, { seasonId: SEASON }, USER)).rejects.toThrow(
        'The team is already in that season'
      );
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('maps a P2002 from a concurrent season move to the sibling 400', async () => {
      (mockPrisma.team.create as jest.Mock).mockRejectedValue(uniqueViolation());
      const err = await TeamService.rolloverTeam(TEAM, { seasonName: '2027' }, USER).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestError);
      expect((err as Error).message).toBe(SEASON_SIBLING_MESSAGE);
    });

    it('rethrows any other failure', async () => {
      (mockPrisma.team.create as jest.Mock).mockRejectedValue(new Error('boom'));
      await expect(TeamService.rolloverTeam(TEAM, { seasonName: '2027' }, USER)).rejects.toThrow('boom');
    });

    it('404s when the new row has vanished before the final read', async () => {
      (mockPrisma.team.findUnique as jest.Mock).mockImplementation((args: { include?: unknown; where: Record<string, unknown> }) => {
        if (args.where.lineageId_seasonId) return Promise.resolve(null);
        return Promise.resolve(args.include ? null : SOURCE);
      });
      await expect(TeamService.rolloverTeam(TEAM, { seasonName: '2027' }, USER)).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
