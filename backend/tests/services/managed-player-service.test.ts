/**
 * Unit tests for managed player functionality in TeamService and PlayerService
 */

import { TeamService } from '../../src/services/team-service';
import { PlayerService } from '../../src/services/player-service';
import { mockPrisma } from '../setup';
import {
  createCoach,
  createPlayer,
  createTeam,
  createTeamRole,
} from '../factories';
import {
  expectNotFoundError,
  expectForbiddenError,
} from '../helpers';

describe('Managed Player - TeamService.addManagedPlayer', () => {
  const coach = createCoach();
  const team = createTeam();
  createTeamRole({
    teamId: team.id,
    type: 'HEAD_COACH',
    name: 'Head Coach',
    canManageRoster: true,
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should create a managed player on a team', async () => {
    const managedUserId = 'managed-player-123';

    // Mock team exists
    (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);

    // Mock permission check - user is admin
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({ ...coach, role: 'ADMIN' });

    // Mock user creation
    (mockPrisma.user.create as jest.Mock).mockResolvedValue({
      id: managedUserId,
      name: 'Young Player',
      role: 'PLAYER',
      isManaged: true,
      managedById: coach.id,
      email: null,
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Mock team member creation
    const mockTeamMember = {
      id: 'member-123',
      teamId: team.id,
      playerId: managedUserId,
      jerseyNumber: 5,
      position: 'PG',
      player: {
        id: managedUserId,
        name: 'Young Player',
        email: null,
        isManaged: true,
        managedById: coach.id,
      },
      team: {
        id: team.id,
        name: team.name,
      },
    };
    (mockPrisma.teamMember.create as jest.Mock).mockResolvedValue(mockTeamMember);

    const result = await TeamService.addManagedPlayer(
      team.id,
      { name: 'Young Player', jerseyNumber: 5, position: 'PG' },
      coach.id
    );

    expect(result.player.isManaged).toBe(true);
    expect(result.player.managedById).toBe(coach.id);
    expect(result.player.email).toBeNull();
    expect(result.jerseyNumber).toBe(5);
    expect(result.position).toBe('PG');

    // Verify user was created with correct data
    expect(mockPrisma.user.create).toHaveBeenCalledWith({
      data: {
        name: 'Young Player',
        role: 'PLAYER',
        isManaged: true,
        managedById: coach.id,
        email: null,
      },
    });
  });

  it('should throw NotFoundError if team does not exist', async () => {
    (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(null);

    try {
      await TeamService.addManagedPlayer(
        'non-existent-team',
        { name: 'Player' },
        coach.id
      );
      fail('Expected NotFoundError');
    } catch (error) {
      expectNotFoundError(error, 'Team not found');
    }
  });

  it('should throw ForbiddenError if user lacks canManageRoster permission', async () => {
    const regularPlayer = createPlayer();

    // Team exists
    (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);

    // Permission check: not admin
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(regularPlayer);
    // Not a league admin
    // Team check for league admin returns no admins
    (mockPrisma.team.findUnique as jest.Mock)
      .mockResolvedValueOnce(team) // First call: team exists
      .mockResolvedValueOnce({ // Second call: permission check (getTeamPermissions)
        ...team,
        season: {
          league: {
            admins: [],
          },
        },
      });
    // No staff roles
    (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([]);
    // Not a team member either
    (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);

    try {
      await TeamService.addManagedPlayer(
        team.id,
        { name: 'Player' },
        regularPlayer.id
      );
      fail('Expected ForbiddenError');
    } catch (error) {
      expectForbiddenError(error);
    }
  });
});

describe('Managed Player - PlayerService.listPlayers (isManaged filter)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should exclude managed players by default', async () => {
    (mockPrisma.user.count as jest.Mock).mockResolvedValue(0);
    (mockPrisma.user.findMany as jest.Mock).mockResolvedValue([]);

    await PlayerService.listPlayers({ limit: 20, offset: 0 });

    expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isManaged: false,
        }),
      })
    );
  });

  it('should include managed players when isManaged=true', async () => {
    (mockPrisma.user.count as jest.Mock).mockResolvedValue(0);
    (mockPrisma.user.findMany as jest.Mock).mockResolvedValue([]);

    await PlayerService.listPlayers({ limit: 20, offset: 0, isManaged: true });

    expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isManaged: true,
        }),
      })
    );
  });

  it('should explicitly filter non-managed when isManaged=false', async () => {
    (mockPrisma.user.count as jest.Mock).mockResolvedValue(0);
    (mockPrisma.user.findMany as jest.Mock).mockResolvedValue([]);

    await PlayerService.listPlayers({ limit: 20, offset: 0, isManaged: false });

    expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isManaged: false,
        }),
      })
    );
  });
});

describe('Managed Player - PlayerService.updatePlayer (coach updating managed player)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should allow managing coach to update their managed player', async () => {
    const coach = createCoach();
    const managedPlayer = {
      ...createPlayer(),
      isManaged: true,
      managedById: coach.id,
    };

    (mockPrisma.user.findUnique as jest.Mock)
      .mockResolvedValueOnce(managedPlayer) // player lookup
      .mockResolvedValueOnce(coach);         // current user lookup
    (mockPrisma.user.update as jest.Mock).mockResolvedValue({
      ...managedPlayer,
      name: 'Updated Name',
    });

    const result = await PlayerService.updatePlayer(
      managedPlayer.id,
      { name: 'Updated Name' },
      coach.id
    );

    expect(result.name).toBe('Updated Name');
  });

  it('should reject non-managing coach from updating managed player', async () => {
    const coach = createCoach();
    const otherCoach = createCoach();
    const managedPlayer = {
      ...createPlayer(),
      isManaged: true,
      managedById: otherCoach.id, // Managed by different coach
    };

    (mockPrisma.user.findUnique as jest.Mock)
      .mockResolvedValueOnce(managedPlayer) // player lookup
      .mockResolvedValueOnce(coach);         // current user lookup

    try {
      await PlayerService.updatePlayer(
        managedPlayer.id,
        { name: 'Hacked Name' },
        coach.id
      );
      fail('Expected ForbiddenError');
    } catch (error) {
      expectForbiddenError(error, 'You can only update your own profile');
    }
  });
});

describe('Managed Player - PlayerService.deletePlayer (coach deleting managed player)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should allow managing coach to delete their managed player', async () => {
    const coach = createCoach();
    const managedPlayer = {
      ...createPlayer(),
      isManaged: true,
      managedById: coach.id,
      teamMembers: [],
      gameEvents: [],
    };

    (mockPrisma.user.findUnique as jest.Mock)
      .mockResolvedValueOnce(coach)          // current user lookup
      .mockResolvedValueOnce(managedPlayer); // player lookup
    (mockPrisma.user.delete as jest.Mock).mockResolvedValue(managedPlayer);

    const result = await PlayerService.deletePlayer(managedPlayer.id, coach.id);

    expect(result).toEqual({ success: true });
  });

  it('should reject non-managing coach from deleting managed player', async () => {
    const coach = createCoach();
    const otherCoach = createCoach();
    const managedPlayer = {
      ...createPlayer(),
      isManaged: true,
      managedById: otherCoach.id,
      teamMembers: [],
      gameEvents: [],
    };

    (mockPrisma.user.findUnique as jest.Mock)
      .mockResolvedValueOnce(coach)          // current user lookup
      .mockResolvedValueOnce(managedPlayer); // player lookup

    try {
      await PlayerService.deletePlayer(managedPlayer.id, coach.id);
      fail('Expected ForbiddenError');
    } catch (error) {
      expectForbiddenError(error, 'Only administrators can delete players');
    }
  });

  it('should still allow admin to delete managed player', async () => {
    const admin = { id: 'admin-id', role: 'ADMIN', email: 'admin@test.com', name: 'Admin' };
    const managedPlayer = {
      ...createPlayer(),
      isManaged: true,
      managedById: 'some-coach-id',
      teamMembers: [],
      gameEvents: [],
    };

    (mockPrisma.user.findUnique as jest.Mock)
      .mockResolvedValueOnce(admin)          // current user lookup
      .mockResolvedValueOnce(managedPlayer); // player lookup
    (mockPrisma.user.delete as jest.Mock).mockResolvedValue(managedPlayer);

    const result = await PlayerService.deletePlayer(managedPlayer.id, admin.id);

    expect(result).toEqual({ success: true });
  });
});

describe('Managed Player - PlayerService.getPlayerById (includes isManaged)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return isManaged and managedById for managed player', async () => {
    const managedPlayer = {
      id: 'managed-123',
      email: null,
      name: 'Young Player',
      role: 'PLAYER',
      profilePictureUrl: null,
      emailVerified: false,
      isManaged: true,
      managedById: 'coach-123',
      createdAt: new Date(),
      updatedAt: new Date(),
      teamMembers: [],
    };

    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(managedPlayer);

    const result = await PlayerService.getPlayerById('managed-123');

    expect(result.isManaged).toBe(true);
    expect(result.managedById).toBe('coach-123');
    expect(result.email).toBeNull();
  });

  it('should return isManaged=false for regular player', async () => {
    const regularPlayer = {
      id: 'regular-123',
      email: 'player@test.com',
      name: 'Regular Player',
      role: 'PLAYER',
      profilePictureUrl: null,
      emailVerified: true,
      isManaged: false,
      managedById: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      teamMembers: [],
    };

    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(regularPlayer);

    const result = await PlayerService.getPlayerById('regular-123');

    expect(result.isManaged).toBe(false);
    expect(result.managedById).toBeNull();
  });
});
