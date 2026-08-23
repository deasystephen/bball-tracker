/**
 * Unit tests for PlayerService
 */

jest.mock('../../src/services/upload-service', () => ({
  deletePreviousAvatar: jest.fn().mockResolvedValue(undefined),
}));

import { Prisma } from '@prisma/client';
import { PlayerService } from '../../src/services/player-service';
import { ConflictError } from '../../src/utils/errors';
import { mockPrisma } from '../setup';
import {
  createPlayer,
  createCoach,
  createAdmin,
  createTeamMember,
  createTeam,
  createSeason,
  createLeague,
  createGameEvent,
} from '../factories';
import { expectNotFoundError, expectBadRequestError } from '../helpers';

import { deletePreviousAvatar } from '../../src/services/upload-service';

const mockDeletePreviousAvatar = deletePreviousAvatar as jest.MockedFunction<typeof deletePreviousAvatar>;

const ADMIN_CALLER = { id: 'admin-caller', role: 'ADMIN' };
const COACH_CALLER = { id: 'coach-caller', role: 'COACH' };

const DAY_MS = 24 * 60 * 60 * 1000;

type MembershipRow = {
  teamId: string;
  team: { season: { league: { admins: { id: string }[] } }; staff: { id: string }[] };
};
/** A `getPlayerTeamAccess` membership row on which the caller has canManageRoster. */
const manageableMembership = (teamId = 'team-1'): MembershipRow => ({
  teamId,
  team: { season: { league: { admins: [] } }, staff: [{ id: 'staff-1' }] },
});
/** A membership row on a team the caller cannot manage. */
const unmanageableMembership = (teamId = 'team-2'): MembershipRow => ({
  teamId,
  team: { season: { league: { admins: [] } }, staff: [] },
});

describe('PlayerService', () => {
  describe('createPlayer', () => {
    it('should create a player successfully (admin)', async () => {
      const player = createPlayer({
        email: 'newplayer@test.com',
        name: 'New Player',
      });

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.user.create as jest.Mock).mockResolvedValue({
        id: player.id,
        email: player.email,
        name: player.name,
        role: 'PLAYER',
        profilePictureUrl: null,
        emailVerified: false,
        createdAt: player.createdAt,
        updatedAt: player.updatedAt,
      });

      const result = await PlayerService.createPlayer(
        { email: 'newplayer@test.com', name: 'New Player' },
        ADMIN_CALLER
      );

      expect(result).toHaveProperty('id', player.id);
      expect(result).toHaveProperty('email', 'newplayer@test.com');
      expect(result).toHaveProperty('role', 'PLAYER');
      // Admins skip the roster-manager lookup
      expect(mockPrisma.teamStaff.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            email: 'newplayer@test.com',
            name: 'New Player',
            role: 'PLAYER',
          }),
        })
      );
    });

    it('should throw BadRequestError if email already exists', async () => {
      const existingPlayer = createPlayer({ email: 'existing@test.com' });

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(existingPlayer);

      try {
        await PlayerService.createPlayer(
          { email: 'existing@test.com', name: 'New Player' },
          ADMIN_CALLER
        );
      } catch (error) {
        expectBadRequestError(error, 'A user with this email already exists');
      }
    });

    it('allows staff who manage a roster somewhere (create & invite flow)', async () => {
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue({ id: 'staff-1' });
      (mockPrisma.leagueAdmin.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.user.create as jest.Mock).mockResolvedValue(createPlayer());

      await PlayerService.createPlayer({ email: 'kid@test.com', name: 'Kid' }, COACH_CALLER);

      expect(mockPrisma.teamStaff.findFirst).toHaveBeenCalledWith({
        where: { userId: COACH_CALLER.id, role: { canManageRoster: true } },
        select: { id: true },
      });
      expect(mockPrisma.user.create).toHaveBeenCalled();
    });

    it('rejects callers who manage no roster (audit #2)', async () => {
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.leagueAdmin.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        PlayerService.createPlayer({ email: 'victim@test.com', name: 'Victim' }, { id: 'random', role: 'PLAYER' })
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.user.create).not.toHaveBeenCalled();
    });

    it('maps a unique-constraint race to ConflictError (409)', async () => {
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.user.create as jest.Mock).mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' })
      );

      await expect(
        PlayerService.createPlayer({ email: 'race@test.com', name: 'Race' }, ADMIN_CALLER)
      ).rejects.toBeInstanceOf(ConflictError);
    });
  });

  describe('getPlayerById', () => {
    it('should return player with teams', async () => {
      const player = createPlayer();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const member = createTeamMember({ teamId: team.id, playerId: player.id });

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({
        id: player.id,
        email: player.email,
        name: player.name,
        role: 'PLAYER',
        profilePictureUrl: null,
        emailVerified: true,
        createdAt: player.createdAt,
        updatedAt: player.updatedAt,
        teamMembers: [{
          ...member,
          team: {
            id: team.id,
            name: team.name,
            season: {
              id: season.id,
              name: season.name,
              league: {
                id: league.id,
                name: league.name,
              },
            },
          },
        }],
      });

      const result = await PlayerService.getPlayerById(player.id, ADMIN_CALLER);

      expect(result).toHaveProperty('id', player.id);
      expect(result.teamMembers).toHaveLength(1);
      expect(result.email).toBe(player.email);
      // Admins are never subjected to the shared-team check
      expect(mockPrisma.user.findFirst).not.toHaveBeenCalled();
    });

    it('returns the player (with email) when looking up yourself', async () => {
      const player = createPlayer();
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({ ...player, teamMembers: [] });

      const result = await PlayerService.getPlayerById(player.id, { id: player.id, role: 'PLAYER' });

      expect(result.id).toBe(player.id);
      expect(result.email).toBe(player.email);
      expect(mockPrisma.user.findFirst).not.toHaveBeenCalled();
    });

    it('returns a teammate without email for a non-admin caller (audit #3)', async () => {
      const player = createPlayer();
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({ ...player, teamMembers: [] });
      (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue({ id: player.id });

      const result = await PlayerService.getPlayerById(player.id, COACH_CALLER);

      expect(result.id).toBe(player.id);
      expect(result.email).toBeNull();
      expect(mockPrisma.user.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: player.id,
            teamMembers: {
              some: {
                team: {
                  OR: [
                    { members: { some: { playerId: COACH_CALLER.id } } },
                    { staff: { some: { userId: COACH_CALLER.id } } },
                  ],
                },
              },
            },
          }),
        })
      );
    });

    it('throws NotFoundError for a non-admin looking up a player outside their teams', async () => {
      const player = createPlayer();
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({ ...player, teamMembers: [] });
      (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(PlayerService.getPlayerById(player.id, COACH_CALLER)).rejects.toThrow('Player not found');
    });

    it('should throw NotFoundError if player does not exist', async () => {
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await PlayerService.getPlayerById('non-existent', ADMIN_CALLER);
      } catch (error) {
        expectNotFoundError(error, 'Player not found');
      }
    });

    it('should throw NotFoundError if user is not a player', async () => {
      const coach = createCoach();

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({
        ...coach,
        teamMembers: [],
      });

      try {
        await PlayerService.getPlayerById(coach.id, ADMIN_CALLER);
      } catch (error) {
        expectNotFoundError(error, 'Player not found');
      }
    });
  });

  describe('listPlayers', () => {
    it('should return all players with pagination', async () => {
      const player1 = createPlayer({ name: 'Player 1' });
      const player2 = createPlayer({ name: 'Player 2' });

      (mockPrisma.user.count as jest.Mock).mockResolvedValue(2);
      (mockPrisma.user.findMany as jest.Mock).mockResolvedValue([
        {
          id: player1.id,
          email: player1.email,
          name: player1.name,
          role: 'PLAYER',
          profilePictureUrl: null,
          emailVerified: true,
          createdAt: player1.createdAt,
          updatedAt: player1.updatedAt,
          _count: { teamMembers: 1 },
        },
        {
          id: player2.id,
          email: player2.email,
          name: player2.name,
          role: 'PLAYER',
          profilePictureUrl: null,
          emailVerified: true,
          createdAt: player2.createdAt,
          updatedAt: player2.updatedAt,
          _count: { teamMembers: 0 },
        },
      ]);

      const result = await PlayerService.listPlayers({ limit: 10, offset: 0 }, ADMIN_CALLER);

      expect(result.players).toHaveLength(2);
      expect(result.pagination.total).toBe(2);
      expect(result.pagination.hasMore).toBe(false);
      // Admins are not scoped to shared teams and get email in the payload
      const call = (mockPrisma.user.findMany as jest.Mock).mock.calls[0][0];
      expect(call.where.AND).toBeUndefined();
      expect(call.select.email).toBe(true);
    });

    it('scopes non-admin callers to themselves + users sharing a team, without email (audit #3)', async () => {
      (mockPrisma.user.count as jest.Mock).mockResolvedValue(0);
      (mockPrisma.user.findMany as jest.Mock).mockResolvedValue([]);

      await PlayerService.listPlayers({ limit: 10, offset: 0 }, COACH_CALLER);

      const call = (mockPrisma.user.findMany as jest.Mock).mock.calls[0][0];
      expect(call.where.role).toBe('PLAYER');
      expect(call.where.isManaged).toBe(false);
      expect(call.where.AND).toEqual([
        {
          OR: [
            { id: COACH_CALLER.id },
            {
              teamMembers: {
                some: {
                  team: {
                    OR: [
                      { members: { some: { playerId: COACH_CALLER.id } } },
                      { staff: { some: { userId: COACH_CALLER.id } } },
                    ],
                  },
                },
              },
            },
          ],
        },
      ]);
      expect(call.select.email).toBe(false);
      expect((mockPrisma.user.count as jest.Mock).mock.calls[0][0].where).toEqual(call.where);
    });

    it('ignores role and isManaged filters for non-admin callers', async () => {
      (mockPrisma.user.count as jest.Mock).mockResolvedValue(0);
      (mockPrisma.user.findMany as jest.Mock).mockResolvedValue([]);

      await PlayerService.listPlayers(
        { role: 'ADMIN', isManaged: true, limit: 10, offset: 0 },
        COACH_CALLER
      );

      const call = (mockPrisma.user.findMany as jest.Mock).mock.calls[0][0];
      expect(call.where.role).toBe('PLAYER');
      expect(call.where.isManaged).toBe(false);
    });

    it('honors role and isManaged filters for admins', async () => {
      (mockPrisma.user.count as jest.Mock).mockResolvedValue(0);
      (mockPrisma.user.findMany as jest.Mock).mockResolvedValue([]);

      await PlayerService.listPlayers(
        { role: 'COACH', isManaged: true, limit: 10, offset: 0 },
        ADMIN_CALLER
      );

      const call = (mockPrisma.user.findMany as jest.Mock).mock.calls[0][0];
      expect(call.where.role).toBe('COACH');
      expect(call.where.isManaged).toBe(true);
    });

    it('matches search against name only for non-admin callers', async () => {
      (mockPrisma.user.count as jest.Mock).mockResolvedValue(0);
      (mockPrisma.user.findMany as jest.Mock).mockResolvedValue([]);

      await PlayerService.listPlayers({ search: 'john@', limit: 10, offset: 0 }, COACH_CALLER);

      const call = (mockPrisma.user.findMany as jest.Mock).mock.calls[0][0];
      expect(call.where.AND).toHaveLength(2);
      expect(call.where.AND[1]).toEqual({ name: { contains: 'john@', mode: 'insensitive' } });
      expect(JSON.stringify(call.where.AND[1])).not.toContain('email');
    });

    it('should filter by search term (admins match name or email)', async () => {
      const player = createPlayer({ name: 'John Doe', email: 'john@test.com' });

      (mockPrisma.user.count as jest.Mock).mockResolvedValue(1);
      (mockPrisma.user.findMany as jest.Mock).mockResolvedValue([{
        id: player.id,
        email: player.email,
        name: player.name,
        role: 'PLAYER',
        profilePictureUrl: null,
        emailVerified: true,
        createdAt: player.createdAt,
        updatedAt: player.updatedAt,
        _count: { teamMembers: 0 },
      }]);

      const result = await PlayerService.listPlayers({
        search: 'John',
        limit: 10,
        offset: 0,
      }, ADMIN_CALLER);

      expect(result.players).toHaveLength(1);
      expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: [
              {
                OR: expect.arrayContaining([
                  expect.objectContaining({ name: expect.anything() }),
                  expect.objectContaining({ email: expect.anything() }),
                ]),
              },
            ],
          }),
        })
      );
    });

    it('should handle pagination correctly', async () => {
      const player = createPlayer();

      (mockPrisma.user.count as jest.Mock).mockResolvedValue(20);
      (mockPrisma.user.findMany as jest.Mock).mockResolvedValue([{
        id: player.id,
        email: player.email,
        name: player.name,
        role: 'PLAYER',
        profilePictureUrl: null,
        emailVerified: true,
        createdAt: player.createdAt,
        updatedAt: player.updatedAt,
        _count: { teamMembers: 0 },
      }]);

      const result = await PlayerService.listPlayers({ limit: 10, offset: 0 }, ADMIN_CALLER);

      expect(result.pagination.hasMore).toBe(true);
      expect(result.pagination.total).toBe(20);
    });
  });

  describe('updatePlayer', () => {
    it('deletes the replaced avatar object after a profilePictureUrl change (audit #61)', async () => {
      const oldUrl = 'https://bball-tracker-avatars-dev.s3.amazonaws.com/avatars/p/old.jpg';
      const newUrl = 'https://bball-tracker-avatars-dev.s3.amazonaws.com/avatars/p/new.jpg';
      const player = createPlayer({ profilePictureUrl: oldUrl });

      (mockPrisma.user.findUnique as jest.Mock)
        .mockResolvedValueOnce(player)
        .mockResolvedValueOnce(player);
      (mockPrisma.user.update as jest.Mock).mockResolvedValue({ ...player, profilePictureUrl: newUrl });

      await PlayerService.updatePlayer(player.id, { profilePictureUrl: newUrl }, player.id);

      expect(mockDeletePreviousAvatar).toHaveBeenCalledWith(oldUrl, newUrl);
    });

    it('does not touch S3 when profilePictureUrl is not part of the update', async () => {
      const player = createPlayer({ name: 'Old Name' });
      (mockPrisma.user.findUnique as jest.Mock)
        .mockResolvedValueOnce(player)
        .mockResolvedValueOnce(player);
      (mockPrisma.user.update as jest.Mock).mockResolvedValue({ ...player, name: 'New' });

      await PlayerService.updatePlayer(player.id, { name: 'New' }, player.id);

      expect(mockDeletePreviousAvatar).not.toHaveBeenCalled();
    });

    it('should update player name (admin updating another player)', async () => {
      const player = createPlayer({ name: 'Old Name' });
      const adminUser = createAdmin();

      (mockPrisma.user.findUnique as jest.Mock)
        .mockResolvedValueOnce(player)    // First call for player
        .mockResolvedValueOnce(adminUser); // Second call for current user (admin)
      (mockPrisma.user.update as jest.Mock).mockResolvedValue({
        ...player,
        name: 'New Name',
      });

      const result = await PlayerService.updatePlayer(
        player.id,
        { name: 'New Name' },
        adminUser.id
      );

      expect(result).toHaveProperty('name', 'New Name');
      expect(mockPrisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: player.id },
          data: expect.objectContaining({ name: 'New Name' }),
        })
      );
    });

    it('should allow player to update themselves', async () => {
      const player = createPlayer({ name: 'Old Name' });

      (mockPrisma.user.findUnique as jest.Mock)
        .mockResolvedValueOnce(player) // First call for player
        .mockResolvedValueOnce(player); // Second call for current user (same player)
      (mockPrisma.user.update as jest.Mock).mockResolvedValue({
        ...player,
        name: 'New Name',
      });

      const result = await PlayerService.updatePlayer(
        player.id,
        { name: 'New Name' },
        player.id
      );

      expect(result).toHaveProperty('name', 'New Name');
    });

    it('should update player email (admin only)', async () => {
      const player = createPlayer({ email: 'old@test.com' });
      const adminUser = createAdmin();

      (mockPrisma.user.findUnique as jest.Mock)
        .mockResolvedValueOnce(player)
        .mockResolvedValueOnce(adminUser)
        .mockResolvedValueOnce(null); // Check for existing email
      (mockPrisma.user.update as jest.Mock).mockResolvedValue({
        ...player,
        email: 'new@test.com',
      });

      const result = await PlayerService.updatePlayer(
        player.id,
        { email: 'new@test.com' },
        adminUser.id
      );

      expect(result).toHaveProperty('email', 'new@test.com');
    });

    it('forbids a player from changing their own email (bound to the login provider)', async () => {
      const player = createPlayer({ email: 'me@test.com' });

      (mockPrisma.user.findUnique as jest.Mock)
        .mockResolvedValueOnce(player)
        .mockResolvedValueOnce(player);

      await expect(
        PlayerService.updatePlayer(player.id, { email: 'squat@test.com' }, player.id)
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });

    it('lets the managing coach set the email of an unclaimed managed player', async () => {
      const coach = createCoach();
      const managed = { ...createPlayer(), email: null, workosUserId: null, isManaged: true, managedById: coach.id };

      (mockPrisma.user.findUnique as jest.Mock)
        .mockResolvedValueOnce(managed)
        .mockResolvedValueOnce(coach)
        .mockResolvedValueOnce(null); // email free
      (mockPrisma.teamMember.findMany as jest.Mock).mockResolvedValue([manageableMembership()]);
      (mockPrisma.user.update as jest.Mock).mockResolvedValue({ ...managed, email: 'kid@test.com' });

      const result = await PlayerService.updatePlayer(managed.id, { email: 'kid@test.com' }, coach.id);

      expect(result.email).toBe('kid@test.com');
    });

    it('forbids the managing coach from rewriting the email once the player has signed in (audit #2)', async () => {
      const coach = createCoach();
      const claimed = { ...createPlayer({ email: 'kid@test.com', workosUserId: 'workos_kid' }), isManaged: true, managedById: coach.id };

      (mockPrisma.user.findUnique as jest.Mock)
        .mockResolvedValueOnce(claimed)
        .mockResolvedValueOnce(coach);
      (mockPrisma.teamMember.findMany as jest.Mock).mockResolvedValue([manageableMembership()]);

      await expect(
        PlayerService.updatePlayer(claimed.id, { email: 'victim@test.com' }, coach.id)
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });

    it('still lets the managing coach rename a claimed managed player', async () => {
      const coach = createCoach();
      const claimed = { ...createPlayer({ email: 'kid@test.com', workosUserId: 'workos_kid' }), isManaged: true, managedById: coach.id };

      (mockPrisma.user.findUnique as jest.Mock)
        .mockResolvedValueOnce(claimed)
        .mockResolvedValueOnce(coach);
      (mockPrisma.teamMember.findMany as jest.Mock).mockResolvedValue([manageableMembership()]);
      (mockPrisma.user.update as jest.Mock).mockResolvedValue({ ...claimed, name: 'Renamed' });

      const result = await PlayerService.updatePlayer(claimed.id, { name: 'Renamed', email: 'kid@test.com' }, coach.id);

      expect(result.name).toBe('Renamed');
    });

    describe('managed-player rights expire with the roster relationship (role matrix B2.10)', () => {
      it('forbids the creator once they no longer manage a roster the player is on', async () => {
        const coach = createCoach();
        const managed = {
          ...createPlayer(),
          isManaged: true,
          managedById: coach.id,
          createdAt: new Date(Date.now() - 30 * DAY_MS),
        };

        (mockPrisma.user.findUnique as jest.Mock)
          .mockResolvedValueOnce(managed)
          .mockResolvedValueOnce(coach);
        // Player is rostered, but on a team where the coach has no canManageRoster
        (mockPrisma.teamMember.findMany as jest.Mock).mockResolvedValue([unmanageableMembership()]);

        await expect(
          PlayerService.updatePlayer(managed.id, { name: 'Hijacked' }, coach.id)
        ).rejects.toMatchObject({ statusCode: 403, message: 'You can only update your own profile' });
        expect(mockPrisma.user.update).not.toHaveBeenCalled();
        expect(mockPrisma.teamMember.findMany).toHaveBeenCalledWith(
          expect.objectContaining({ where: { playerId: managed.id } })
        );
      });

      it('forbids the creator of an old, un-rostered managed player (grace period elapsed)', async () => {
        const coach = createCoach();
        const managed = {
          ...createPlayer(),
          isManaged: true,
          managedById: coach.id,
          createdAt: new Date(Date.now() - 2 * DAY_MS),
        };

        (mockPrisma.user.findUnique as jest.Mock)
          .mockResolvedValueOnce(managed)
          .mockResolvedValueOnce(coach);
        (mockPrisma.teamMember.findMany as jest.Mock).mockResolvedValue([]);

        await expect(
          PlayerService.updatePlayer(managed.id, { name: 'Late edit' }, coach.id)
        ).rejects.toMatchObject({ statusCode: 403 });
      });

      it('lets the creator edit a just-created managed player before it is rostered (create-then-edit)', async () => {
        const coach = createCoach();
        const managed = {
          ...createPlayer(),
          isManaged: true,
          managedById: coach.id,
          createdAt: new Date(Date.now() - 5 * 60 * 1000),
        };

        (mockPrisma.user.findUnique as jest.Mock)
          .mockResolvedValueOnce(managed)
          .mockResolvedValueOnce(coach);
        (mockPrisma.teamMember.findMany as jest.Mock).mockResolvedValue([]);
        (mockPrisma.user.update as jest.Mock).mockResolvedValue({ ...managed, name: 'Fixed typo' });

        const result = await PlayerService.updatePlayer(managed.id, { name: 'Fixed typo' }, coach.id);

        expect(result.name).toBe('Fixed typo');
      });

      it('never grants rights to a non-managed player via managedById', async () => {
        const coach = createCoach();
        const player = { ...createPlayer(), isManaged: false, managedById: coach.id };

        (mockPrisma.user.findUnique as jest.Mock)
          .mockResolvedValueOnce(player)
          .mockResolvedValueOnce(coach);

        await expect(
          PlayerService.updatePlayer(player.id, { name: 'Nope' }, coach.id)
        ).rejects.toMatchObject({ statusCode: 403 });
        expect(mockPrisma.teamMember.findMany).not.toHaveBeenCalled();
      });
    });

    it('should throw NotFoundError if player does not exist', async () => {
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await PlayerService.updatePlayer('non-existent', { name: 'New Name' }, 'user-id');
      } catch (error) {
        expectNotFoundError(error, 'Player not found');
      }
    });

    it('should throw NotFoundError if user is not a player', async () => {
      const coach = createCoach();

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);

      try {
        await PlayerService.updatePlayer(coach.id, { name: 'New Name' }, 'user-id');
      } catch (error) {
        expectNotFoundError(error, 'Player not found');
      }
    });

    it('should throw ForbiddenError when non-admin updates another player', async () => {
      const player = createPlayer({ email: 'player@test.com' });
      const coach = createCoach();

      (mockPrisma.user.findUnique as jest.Mock)
        .mockResolvedValueOnce(player)
        .mockResolvedValueOnce(coach); // non-admin, different user

      try {
        await PlayerService.updatePlayer(
          player.id,
          { name: 'Hacked Name' },
          coach.id
        );
        fail('Expected ForbiddenError');
      } catch (error) {
        const err = error as Error & { statusCode?: number };
        expect(err.statusCode).toBe(403);
        expect(err.message).toBe('You can only update your own profile');
      }
    });

    it('should throw BadRequestError if email is already taken', async () => {
      const player = createPlayer({ email: 'old@test.com' });
      const existingPlayer = createPlayer({ email: 'existing@test.com' });
      const adminUser = createAdmin();

      (mockPrisma.user.findUnique as jest.Mock)
        .mockResolvedValueOnce(player)
        .mockResolvedValueOnce(adminUser)
        .mockResolvedValueOnce(existingPlayer); // Existing user with email

      try {
        await PlayerService.updatePlayer(
          player.id,
          { email: 'existing@test.com' },
          adminUser.id
        );
      } catch (error) {
        expectBadRequestError(error, 'A user with this email already exists');
      }
    });
  });

  describe('deletePlayer', () => {
    const adminUser = { id: 'admin-id', role: 'ADMIN', email: 'admin@test.com', name: 'Admin' };

    it('should delete player successfully', async () => {
      const player = createPlayer();

      (mockPrisma.user.findUnique as jest.Mock)
        .mockResolvedValueOnce(adminUser) // admin check
        .mockResolvedValueOnce({          // player lookup
          ...player,
          teamMembers: [],
          gameEvents: [],
        });
      (mockPrisma.user.delete as jest.Mock).mockResolvedValue(player);

      const result = await PlayerService.deletePlayer(player.id, 'admin-id');

      expect(result).toEqual({ success: true });
      expect(mockPrisma.user.delete).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: player.id },
        })
      );
    });

    it('should throw NotFoundError if admin user does not exist', async () => {
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce(null);

      try {
        await PlayerService.deletePlayer('non-existent', 'admin-id');
      } catch (error) {
        expectNotFoundError(error, 'User not found');
      }
    });

    it('should throw NotFoundError if player does not exist', async () => {
      (mockPrisma.user.findUnique as jest.Mock)
        .mockResolvedValueOnce(adminUser)  // admin check
        .mockResolvedValueOnce(null);       // player not found

      try {
        await PlayerService.deletePlayer('non-existent', 'admin-id');
      } catch (error) {
        expectNotFoundError(error, 'Player not found');
      }
    });

    it('should throw NotFoundError if user is not a player', async () => {
      const coach = createCoach();

      (mockPrisma.user.findUnique as jest.Mock)
        .mockResolvedValueOnce(adminUser)  // admin check
        .mockResolvedValueOnce({           // coach (not player role)
          ...coach,
          teamMembers: [],
          gameEvents: [],
        });

      try {
        await PlayerService.deletePlayer(coach.id, 'admin-id');
      } catch (error) {
        expectNotFoundError(error, 'Player not found');
      }
    });

    it('should throw BadRequestError if player is on teams', async () => {
      const player = createPlayer();
      const team = createTeam();
      const member = createTeamMember({ teamId: team.id, playerId: player.id });

      (mockPrisma.user.findUnique as jest.Mock)
        .mockResolvedValueOnce(adminUser)  // admin check
        .mockResolvedValueOnce({           // player with teams
          ...player,
          teamMembers: [member],
          gameEvents: [],
        });

      try {
        await PlayerService.deletePlayer(player.id, 'admin-id');
      } catch (error) {
        expectBadRequestError(
          error,
          'Cannot delete player who is currently on teams. Remove player from all teams first.'
        );
      }
    });

    it('should throw BadRequestError if player has game events', async () => {
      const player = createPlayer();
      const event = createGameEvent({ playerId: player.id });

      (mockPrisma.user.findUnique as jest.Mock)
        .mockResolvedValueOnce(adminUser)  // admin check
        .mockResolvedValueOnce({           // player with events
          ...player,
          teamMembers: [],
          gameEvents: [event],
        });

      try {
        await PlayerService.deletePlayer(player.id, 'admin-id');
      } catch (error) {
        expectBadRequestError(
          error,
          'Cannot delete player with game history. Player data must be preserved for statistics.'
        );
      }
    });

    it('should throw ForbiddenError for non-admin users', async () => {
      const player = createPlayer();
      const coach = createCoach();

      (mockPrisma.user.findUnique as jest.Mock)
        .mockResolvedValueOnce(coach)  // current user (non-admin)
        .mockResolvedValueOnce({       // player lookup
          ...player,
          isManaged: false,
          managedById: null,
          teamMembers: [],
          gameEvents: [],
        });

      try {
        await PlayerService.deletePlayer(player.id, coach.id);
        fail('Expected ForbiddenError');
      } catch (error) {
        const err = error as Error & { statusCode?: number };
        expect(err.statusCode).toBe(403);
        expect(err.message).toBe('Only administrators can delete players');
      }
    });

    it('lets the creator delete a just-created, un-rostered managed player', async () => {
      const coach = createCoach();
      const managed = {
        ...createPlayer(),
        isManaged: true,
        managedById: coach.id,
        createdAt: new Date(),
        teamMembers: [],
        gameEvents: [],
      };

      (mockPrisma.user.findUnique as jest.Mock)
        .mockResolvedValueOnce(coach)
        .mockResolvedValueOnce(managed);
      (mockPrisma.teamMember.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.user.delete as jest.Mock).mockResolvedValue(managed);

      await expect(PlayerService.deletePlayer(managed.id, coach.id)).resolves.toEqual({ success: true });
    });

    it('forbids the creator from deleting an old un-rostered managed player (B2.10)', async () => {
      const coach = createCoach();
      const managed = {
        ...createPlayer(),
        isManaged: true,
        managedById: coach.id,
        createdAt: new Date(Date.now() - 3 * DAY_MS),
        teamMembers: [],
        gameEvents: [],
      };

      (mockPrisma.user.findUnique as jest.Mock)
        .mockResolvedValueOnce(coach)
        .mockResolvedValueOnce(managed);
      (mockPrisma.teamMember.findMany as jest.Mock).mockResolvedValue([]);

      await expect(PlayerService.deletePlayer(managed.id, coach.id)).rejects.toMatchObject({
        statusCode: 403,
        message: 'Only administrators can delete players',
      });
      expect(mockPrisma.user.delete).not.toHaveBeenCalled();
    });
  });
});
