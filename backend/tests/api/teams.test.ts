/**
 * Teams API Integration Tests
 */

import request from 'supertest';
import { app, httpServer } from '../../src/index';
import { TeamService } from '../../src/services/team-service';
import { InvitationService } from '../../src/services/invitation-service';
import { NotFoundError, ForbiddenError, PaymentRequiredError, BadRequestError } from '../../src/utils/errors';
import { invalidateUsage } from '../../src/services/usage-service';
import { prismaMock } from '../setup';

/** Distinct-team rows as returned by `countDistinctStaffTeams` (audit B2.8). */
function staffTeams(n: number): Array<{ teamId: string }> {
  return Array.from({ length: n }, (_, i) => ({ teamId: `team-${i}` }));
}

// Test UUIDs
const TEST_USER_ID = 'a1b2c3d4-e5f6-4890-a234-567890abcdef';
const TEST_TEAM_ID = 'b2c3d4e5-f6a7-4901-a345-67890abcdef0';
const TEST_LEAGUE_ID = 'c3d4e5f6-a7b8-4012-a456-7890abcdef01';
const TEST_SEASON_ID = 'f6a7b8c9-d0e1-4345-a789-0abcdef01234';
const TEST_PLAYER_ID = 'd4e5f6a7-b8c9-4123-a567-890abcdef012';

// Mutable mock auth user. Team creation is behind the FREE-tier team-count cap
// (`requireTeamCreateLimit`). PREMIUM short-circuits that check (unlimited), so
// the default user is an active PREMIUM coach to keep the create/validation
// tests focused on their own concerns. The dedicated 'FREE-tier team limit'
// block below flips this to FREE to exercise the cap + grandfather rule.
const mockAuthUser: {
  id: string;
  email: string;
  name: string;
  role: string;
  subscriptionTier: 'FREE' | 'PREMIUM' | 'LEAGUE';
  subscriptionExpiresAt: Date | null;
} = {
  id: 'a1b2c3d4-e5f6-4890-a234-567890abcdef',
  email: 'test@example.com',
  name: 'Test User',
  role: 'COACH',
  subscriptionTier: 'PREMIUM',
  subscriptionExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
};

// Mock the authenticate middleware
jest.mock('../../src/api/auth/middleware', () => ({
  authenticate: jest.fn((req, _res, next) => {
    req.user = { ...mockAuthUser };
    next();
  }),
}));

// Mock the services
jest.mock('../../src/services/team-service');
jest.mock('../../src/services/invitation-service');

// Mock the usage service: these tests focus on team CRUD, not tier limits, so
// allow creation by default. Tier-limit enforcement is covered in usage.test.ts.
jest.mock('../../src/services/usage-service', () => ({
  canCreateTeam: jest.fn().mockResolvedValue(true),
  invalidateUsage: jest.fn().mockResolvedValue(undefined),
}));

const mockTeamService = TeamService as jest.Mocked<typeof TeamService>;
const mockInvitationService = InvitationService as jest.Mocked<typeof InvitationService>;

describe('Teams API', () => {
  const mockTeam = {
    id: TEST_TEAM_ID,
    name: 'Lakers',
    seasonId: TEST_SEASON_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
    season: {
      id: TEST_SEASON_ID,
      name: 'Spring 2024',
      league: { id: TEST_LEAGUE_ID, name: 'Spring League' },
    },
    staff: [{ userId: TEST_USER_ID, user: { id: TEST_USER_ID, name: 'Test User', email: 'test@example.com' }, role: { name: 'Head Coach' } }],
    members: [],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthUser.subscriptionTier = 'PREMIUM';
    mockAuthUser.subscriptionExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  });

  describe('POST /api/v1/teams', () => {
    it('should create a team successfully', async () => {
      mockTeamService.createTeam.mockResolvedValue(mockTeam as unknown as Awaited<ReturnType<typeof mockTeamService.createTeam>>);

      const response = await request(app)
        .post('/api/v1/teams')
        .send({ name: 'Lakers', seasonId: TEST_SEASON_ID });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.team).toBeDefined();
      expect(mockTeamService.createTeam).toHaveBeenCalledWith(
        { name: 'Lakers', seasonId: TEST_SEASON_ID },
        TEST_USER_ID
      );
    });

    it('should return 400 for missing required fields', async () => {
      const response = await request(app)
        .post('/api/v1/teams')
        .send({ name: 'Lakers' }); // Missing seasonId

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    it('should return 400 for invalid data', async () => {
      const response = await request(app)
        .post('/api/v1/teams')
        .send({ name: '', seasonId: TEST_SEASON_ID }); // Empty name

      expect(response.status).toBe(400);
    });

    it('should create a team with chatLink', async () => {
      const teamWithChat = { ...mockTeam, chatLink: 'https://chat.whatsapp.com/abc123' };
      mockTeamService.createTeam.mockResolvedValue(teamWithChat as unknown as Awaited<ReturnType<typeof mockTeamService.createTeam>>);

      const response = await request(app)
        .post('/api/v1/teams')
        .send({ name: 'Lakers', seasonId: TEST_SEASON_ID, chatLink: 'https://chat.whatsapp.com/abc123' });

      expect(response.status).toBe(201);
      expect(mockTeamService.createTeam).toHaveBeenCalledWith(
        expect.objectContaining({ chatLink: 'https://chat.whatsapp.com/abc123' }),
        TEST_USER_ID
      );
    });

    it('should reject chatLink with non-http protocol', async () => {
      const response = await request(app)
        .post('/api/v1/teams')
        .send({ name: 'Lakers', seasonId: TEST_SEASON_ID, chatLink: 'javascript:alert(1)' });

      expect(response.status).toBe(400);
    });

    it('should handle service errors', async () => {
      mockTeamService.createTeam.mockRejectedValue(new NotFoundError('Season not found'));

      const response = await request(app)
        .post('/api/v1/teams')
        .send({ name: 'Lakers', seasonId: TEST_SEASON_ID });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Season not found');
    });
  });

  // Issue #40: FREE-tier team cap is enforced on create (grandfathered).
  describe('POST /api/v1/teams - FREE-tier team limit (grandfathering)', () => {
    beforeEach(() => {
      mockAuthUser.subscriptionTier = 'FREE';
      mockAuthUser.subscriptionExpiresAt = null;
    });

    it('allows a FREE user under the limit to create a team', async () => {
      (prismaMock.teamStaff.findMany as jest.Mock).mockResolvedValue(staffTeams(2));
      mockTeamService.createTeam.mockResolvedValue(mockTeam as unknown as Awaited<ReturnType<typeof mockTeamService.createTeam>>);

      const response = await request(app)
        .post('/api/v1/teams')
        .send({ name: 'Lakers', seasonId: TEST_SEASON_ID });

      expect(response.status).toBe(201);
      expect(mockTeamService.createTeam).toHaveBeenCalled();
    });

    it('maps a PaymentRequiredError raised inside the create transaction to the same 402 body', async () => {
      // Middleware pre-check passes (count says 2) but a concurrent create
      // committed first; the service's locked recount wins (audit #49).
      (prismaMock.teamStaff.findMany as jest.Mock).mockResolvedValue(staffTeams(2));
      mockTeamService.createTeam.mockRejectedValue(
        new PaymentRequiredError({ feature: 'unlimited_teams', currentTier: 'FREE', requiredTier: 'PREMIUM' })
      );

      const response = await request(app)
        .post('/api/v1/teams')
        .send({ name: 'Lakers', seasonId: TEST_SEASON_ID });

      expect(response.status).toBe(402);
      expect(response.body).toEqual({
        code: 'upgrade_required',
        feature: 'unlimited_teams',
        currentTier: 'FREE',
        requiredTier: 'PREMIUM',
      });
    });

    it('blocks a FREE user at the limit with 402 upgrade_required', async () => {
      (prismaMock.teamStaff.findMany as jest.Mock).mockResolvedValue(staffTeams(3));

      const response = await request(app)
        .post('/api/v1/teams')
        .send({ name: 'Lakers', seasonId: TEST_SEASON_ID });

      expect(response.status).toBe(402);
      expect(response.body).toEqual({
        code: 'upgrade_required',
        feature: 'unlimited_teams',
        currentTier: 'FREE',
        requiredTier: 'PREMIUM',
      });
      expect(mockTeamService.createTeam).not.toHaveBeenCalled();
    });

    it('GRANDFATHERS over-limit FREE users: existing teams remain, new create blocked', async () => {
      // A user already over the cap (e.g. downgraded from PREMIUM with 5 teams)
      // keeps those teams (no deletion happens here) but cannot create more.
      (prismaMock.teamStaff.findMany as jest.Mock).mockResolvedValue(staffTeams(5));

      const response = await request(app)
        .post('/api/v1/teams')
        .send({ name: 'Sixth Team', seasonId: TEST_SEASON_ID });

      expect(response.status).toBe(402);
      expect(response.body.code).toBe('upgrade_required');
      // The create is blocked but nothing about the existing teams is mutated.
      expect(mockTeamService.createTeam).not.toHaveBeenCalled();
      expect(prismaMock.teamStaff.delete).not.toHaveBeenCalled();
    });

    it('allows a PREMIUM user unlimited team creation without a count query', async () => {
      mockAuthUser.subscriptionTier = 'PREMIUM';
      mockAuthUser.subscriptionExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      mockTeamService.createTeam.mockResolvedValue(mockTeam as unknown as Awaited<ReturnType<typeof mockTeamService.createTeam>>);

      const response = await request(app)
        .post('/api/v1/teams')
        .send({ name: 'Lakers', seasonId: TEST_SEASON_ID });

      expect(response.status).toBe(201);
      expect(prismaMock.teamStaff.findMany).not.toHaveBeenCalled();
    });

    it('allows a LEAGUE user unlimited team creation', async () => {
      mockAuthUser.subscriptionTier = 'LEAGUE';
      mockAuthUser.subscriptionExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      mockTeamService.createTeam.mockResolvedValue(mockTeam as unknown as Awaited<ReturnType<typeof mockTeamService.createTeam>>);

      const response = await request(app)
        .post('/api/v1/teams')
        .send({ name: 'Lakers', seasonId: TEST_SEASON_ID });

      expect(response.status).toBe(201);
      expect(prismaMock.teamStaff.findMany).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/v1/teams', () => {
    it('should list teams successfully', async () => {
      mockTeamService.listTeams.mockResolvedValue({
        teams: [mockTeam],
        pagination: { total: 1, limit: 10, offset: 0, hasMore: false },
      } as unknown as Awaited<ReturnType<typeof mockTeamService.listTeams>>);

      const response = await request(app).get('/api/v1/teams');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.teams).toHaveLength(1);
      expect(response.body.pagination).toBeDefined();
    });

    it('should filter teams by leagueId', async () => {
      mockTeamService.listTeams.mockResolvedValue({
        teams: [mockTeam],
        pagination: { total: 1, limit: 10, offset: 0, hasMore: false },
      } as unknown as Awaited<ReturnType<typeof mockTeamService.listTeams>>);

      const response = await request(app)
        .get('/api/v1/teams')
        .query({ leagueId: TEST_LEAGUE_ID });

      expect(response.status).toBe(200);
      expect(mockTeamService.listTeams).toHaveBeenCalledWith(
        expect.objectContaining({ leagueId: TEST_LEAGUE_ID }),
        TEST_USER_ID
      );
    });

    it('should filter teams by playerId and still pass the caller id for access scoping', async () => {
      mockTeamService.listTeams.mockResolvedValue({
        teams: [],
        total: 0,
        limit: 20,
        offset: 0,
      } as unknown as Awaited<ReturnType<typeof mockTeamService.listTeams>>);

      const otherPlayerId = 'b2c3d4e5-f6a7-4901-b345-67890abcdef0';
      const response = await request(app)
        .get('/api/v1/teams')
        .query({ playerId: otherPlayerId });

      expect(response.status).toBe(200);
      expect(response.body.teams).toEqual([]);
      expect(mockTeamService.listTeams).toHaveBeenCalledWith(
        expect.objectContaining({ playerId: otherPlayerId }),
        TEST_USER_ID
      );
    });

    it('should filter teams by seasonId', async () => {
      mockTeamService.listTeams.mockResolvedValue({
        teams: [mockTeam],
        pagination: { total: 1, limit: 10, offset: 0, hasMore: false },
      } as unknown as Awaited<ReturnType<typeof mockTeamService.listTeams>>);

      const response = await request(app)
        .get('/api/v1/teams')
        .query({ seasonId: TEST_SEASON_ID });

      expect(response.status).toBe(200);
      expect(mockTeamService.listTeams).toHaveBeenCalledWith(
        expect.objectContaining({ seasonId: TEST_SEASON_ID }),
        TEST_USER_ID
      );
    });
  });

  describe('GET /api/v1/teams/:id', () => {
    it('should get a team by ID', async () => {
      mockTeamService.getTeamById.mockResolvedValue(mockTeam as unknown as Awaited<ReturnType<typeof mockTeamService.getTeamById>>);

      const response = await request(app).get(`/api/v1/teams/${TEST_TEAM_ID}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.team.id).toBe(TEST_TEAM_ID);
    });

    it('should return 404 for non-existent team', async () => {
      mockTeamService.getTeamById.mockRejectedValue(new NotFoundError('Team not found'));

      const response = await request(app).get('/api/v1/teams/00000000-0000-0000-0000-000000000000');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Team not found');
    });

    it('should return 403 for forbidden access', async () => {
      mockTeamService.getTeamById.mockRejectedValue(new ForbiddenError('Access denied'));

      const response = await request(app).get(`/api/v1/teams/${TEST_TEAM_ID}`);

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('Access denied');
    });

    it('should pass through a member list without emails unchanged (non-manager view)', async () => {
      mockTeamService.getTeamById.mockResolvedValue({
        ...mockTeam,
        members: [
          { playerId: 'p-1', jerseyNumber: 7, player: { id: 'p-1', name: 'Player One' } },
        ],
      } as unknown as Awaited<ReturnType<typeof mockTeamService.getTeamById>>);

      const response = await request(app).get(`/api/v1/teams/${TEST_TEAM_ID}`);

      expect(response.status).toBe(200);
      expect(mockTeamService.getTeamById).toHaveBeenCalledWith(TEST_TEAM_ID, TEST_USER_ID);
      expect(response.body.team.members[0].player).toEqual({ id: 'p-1', name: 'Player One' });
      expect(response.body.team.members[0].player.email).toBeUndefined();
    });
  });

  describe('PATCH /api/v1/teams/:id', () => {
    it('should update a team successfully', async () => {
      const updatedTeam = { ...mockTeam, name: 'Updated Lakers' };
      mockTeamService.updateTeam.mockResolvedValue(updatedTeam as unknown as Awaited<ReturnType<typeof mockTeamService.updateTeam>>);

      const response = await request(app)
        .patch(`/api/v1/teams/${TEST_TEAM_ID}`)
        .send({ name: 'Updated Lakers' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.team.name).toBe('Updated Lakers');
    });

    it('should return 400 for invalid update data', async () => {
      const response = await request(app)
        .patch(`/api/v1/teams/${TEST_TEAM_ID}`)
        .send({ name: '' }); // Empty name

      expect(response.status).toBe(400);
    });

    it('should return 404 for non-existent team', async () => {
      mockTeamService.updateTeam.mockRejectedValue(new NotFoundError('Team not found'));

      const response = await request(app)
        .patch('/api/v1/teams/00000000-0000-0000-0000-000000000000')
        .send({ name: 'New Name' });

      expect(response.status).toBe(404);
    });

    it('should return 403 for unauthorized update', async () => {
      mockTeamService.updateTeam.mockRejectedValue(new ForbiddenError('Not authorized'));

      const response = await request(app)
        .patch(`/api/v1/teams/${TEST_TEAM_ID}`)
        .send({ name: 'New Name' });

      expect(response.status).toBe(403);
    });

    it('should return 403 when moving the team into a season whose league the caller does not administer', async () => {
      mockTeamService.updateTeam.mockRejectedValue(
        new ForbiddenError('You do not have permission to move this team into that season')
      );

      const response = await request(app)
        .patch(`/api/v1/teams/${TEST_TEAM_ID}`)
        .send({ seasonId: TEST_SEASON_ID });

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('You do not have permission to move this team into that season');
      expect(mockTeamService.updateTeam).toHaveBeenCalledWith(
        TEST_TEAM_ID,
        expect.objectContaining({ seasonId: TEST_SEASON_ID }),
        TEST_USER_ID
      );
    });

    it('should update chatLink', async () => {
      const updatedTeam = { ...mockTeam, chatLink: 'https://t.me/team_chat' };
      mockTeamService.updateTeam.mockResolvedValue(updatedTeam as unknown as Awaited<ReturnType<typeof mockTeamService.updateTeam>>);

      const response = await request(app)
        .patch(`/api/v1/teams/${TEST_TEAM_ID}`)
        .send({ chatLink: 'https://t.me/team_chat' });

      expect(response.status).toBe(200);
      expect(mockTeamService.updateTeam).toHaveBeenCalledWith(
        TEST_TEAM_ID,
        expect.objectContaining({ chatLink: 'https://t.me/team_chat' }),
        TEST_USER_ID
      );
    });

    it('should clear chatLink with null', async () => {
      const updatedTeam = { ...mockTeam, chatLink: null };
      mockTeamService.updateTeam.mockResolvedValue(updatedTeam as unknown as Awaited<ReturnType<typeof mockTeamService.updateTeam>>);

      const response = await request(app)
        .patch(`/api/v1/teams/${TEST_TEAM_ID}`)
        .send({ chatLink: null });

      expect(response.status).toBe(200);
      expect(mockTeamService.updateTeam).toHaveBeenCalledWith(
        TEST_TEAM_ID,
        expect.objectContaining({ chatLink: null }),
        TEST_USER_ID
      );
    });
  });

  describe('DELETE /api/v1/teams/:id', () => {
    it('should delete a team successfully', async () => {
      mockTeamService.deleteTeam.mockResolvedValue({ success: true });

      const response = await request(app).delete(`/api/v1/teams/${TEST_TEAM_ID}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Team deleted successfully');
    });

    it('should return 404 for non-existent team', async () => {
      mockTeamService.deleteTeam.mockRejectedValue(new NotFoundError('Team not found'));

      const response = await request(app).delete('/api/v1/teams/00000000-0000-0000-0000-000000000000');

      expect(response.status).toBe(404);
    });

    it('should return 403 for unauthorized delete', async () => {
      mockTeamService.deleteTeam.mockRejectedValue(new ForbiddenError('Not authorized'));

      const response = await request(app).delete(`/api/v1/teams/${TEST_TEAM_ID}`);

      expect(response.status).toBe(403);
    });
  });

  describe('POST /api/v1/teams/:teamId/players (unified Add Player)', () => {
    // The 410 tombstone that lived on this path is gone — the unified Add
    // Player flow (roster/invite unification spec) reclaims it.
    const mockAddResult = {
      rostered: true,
      invited: false,
      member: {
        teamId: TEST_TEAM_ID,
        playerId: TEST_PLAYER_ID,
        player: { id: TEST_PLAYER_ID, name: 'Jane Hooper', email: null, isManaged: true, managedById: TEST_USER_ID },
        team: { id: TEST_TEAM_ID, name: 'Test Team' },
      },
      invitation: null,
      guardianInvited: false,
      emails: {},
    };

    it('adds a roster-only player (case 1) and returns 201', async () => {
      mockInvitationService.addRosterPlayer.mockResolvedValue(
        mockAddResult as unknown as Awaited<ReturnType<typeof mockInvitationService.addRosterPlayer>>
      );

      const response = await request(app)
        .post(`/api/v1/teams/${TEST_TEAM_ID}/players`)
        .send({ name: 'Jane Hooper', jerseyNumber: 0 });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.rostered).toBe(true);
      expect(response.body.member).toBeDefined();
      expect(mockInvitationService.addRosterPlayer).toHaveBeenCalledWith(
        TEST_TEAM_ID,
        expect.objectContaining({ name: 'Jane Hooper', jerseyNumber: 0 }),
        TEST_USER_ID
      );
    });

    it('never leaks a token in the response, whatever the service returns', async () => {
      mockInvitationService.addRosterPlayer.mockResolvedValue({
        ...mockAddResult,
        invited: true,
        invitation: { id: 'f6a7b8c9-d0e1-4345-a789-0abcdef01234', status: 'PENDING' },
        emails: { player: true },
      } as unknown as Awaited<ReturnType<typeof mockInvitationService.addRosterPlayer>>);

      const response = await request(app)
        .post(`/api/v1/teams/${TEST_TEAM_ID}/players`)
        .send({ name: 'Jane Hooper', playerEmail: 'jane@example.com' });

      expect(response.status).toBe(201);
      expect(JSON.stringify(response.body)).not.toContain('token');
    });

    it('rejects a guardian email without a relationship (400)', async () => {
      const response = await request(app)
        .post(`/api/v1/teams/${TEST_TEAM_ID}/players`)
        .send({ name: 'Jane', guardianEmail: 'mom@example.com' });

      expect(response.status).toBe(400);
      expect(mockInvitationService.addRosterPlayer).not.toHaveBeenCalled();
    });

    it('rejects identical player and guardian emails (400)', async () => {
      const response = await request(app)
        .post(`/api/v1/teams/${TEST_TEAM_ID}/players`)
        .send({
          name: 'Jane',
          playerEmail: 'same@example.com',
          guardianEmail: 'Same@Example.com',
          guardianRelationship: 'MOTHER',
        });

      expect(response.status).toBe(400);
      expect(mockInvitationService.addRosterPlayer).not.toHaveBeenCalled();
    });

    it('maps a Forbidden service error to 403', async () => {
      mockInvitationService.addRosterPlayer.mockRejectedValue(
        new ForbiddenError("You do not have permission to manage this team's roster")
      );

      const response = await request(app)
        .post(`/api/v1/teams/${TEST_TEAM_ID}/players`)
        .send({ name: 'Jane Hooper' });

      expect(response.status).toBe(403);
    });

    it('maps NotFound to 404, BadRequest to 400 and unknown throws to a generic 500', async () => {
      mockInvitationService.addRosterPlayer.mockRejectedValueOnce(new NotFoundError('Team not found'));
      let response = await request(app)
        .post(`/api/v1/teams/${TEST_TEAM_ID}/players`)
        .send({ name: 'Jane' });
      expect(response.status).toBe(404);

      mockInvitationService.addRosterPlayer.mockRejectedValueOnce(
        new BadRequestError('Player is already on this team')
      );
      response = await request(app)
        .post(`/api/v1/teams/${TEST_TEAM_ID}/players`)
        .send({ name: 'Jane' });
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Player is already on this team');

      mockInvitationService.addRosterPlayer.mockRejectedValueOnce(new Error('db exploded: secret detail'));
      response = await request(app)
        .post(`/api/v1/teams/${TEST_TEAM_ID}/players`)
        .send({ name: 'Jane' });
      expect(response.status).toBe(500);
      // Internal detail never reaches the client
      expect(response.body.error).toBe('Failed to add player');
    });
  });

  describe('POST /api/v1/teams/:teamId/invitations', () => {
    const mockInvitation = {
      id: 'f6a7b8c9-d0e1-4345-a789-0abcdef01234',
      teamId: TEST_TEAM_ID,
      playerId: TEST_PLAYER_ID,
      invitedById: TEST_USER_ID,
      status: 'PENDING',
      token: 'abc123',
      expiresAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it('should create an invitation successfully', async () => {
      mockInvitationService.createInvitation.mockResolvedValue({
        invitation: mockInvitation,
        emailSent: true,
      } as unknown as Awaited<ReturnType<typeof mockInvitationService.createInvitation>>);

      const response = await request(app)
        .post(`/api/v1/teams/${TEST_TEAM_ID}/invitations`)
        .send({ playerId: TEST_PLAYER_ID });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.invitation).toBeDefined();
      expect(response.body.emailSent).toBe(true);
      // Audit #14: the token only travels in the invitation email.
      expect(response.body.invitation).not.toHaveProperty('token');
      expect(JSON.stringify(response.body)).not.toContain('abc123');
    });

    it('surfaces a failed invitation email as emailSent: false', async () => {
      mockInvitationService.createInvitation.mockResolvedValue({
        invitation: mockInvitation,
        emailSent: false,
      } as unknown as Awaited<ReturnType<typeof mockInvitationService.createInvitation>>);

      const response = await request(app)
        .post(`/api/v1/teams/${TEST_TEAM_ID}/invitations`)
        .send({ playerId: TEST_PLAYER_ID });

      expect(response.status).toBe(201);
      expect(response.body.emailSent).toBe(false);
    });

    it('passes supersede through to the service (resend path)', async () => {
      mockInvitationService.createInvitation.mockResolvedValue({
        invitation: mockInvitation,
        emailSent: true,
      } as unknown as Awaited<ReturnType<typeof mockInvitationService.createInvitation>>);

      const response = await request(app)
        .post(`/api/v1/teams/${TEST_TEAM_ID}/invitations`)
        .send({ playerId: TEST_PLAYER_ID, supersede: true });

      expect(response.status).toBe(201);
      expect(mockInvitationService.createInvitation).toHaveBeenCalledWith(
        TEST_TEAM_ID,
        expect.objectContaining({ playerId: TEST_PLAYER_ID, supersede: true }),
        TEST_USER_ID
      );
    });

    it('should return 400 for missing playerId', async () => {
      const response = await request(app)
        .post(`/api/v1/teams/${TEST_TEAM_ID}/invitations`)
        .send({});

      expect(response.status).toBe(400);
    });

    it('should create-and-invite a new player with name + email in one call (audit #69)', async () => {
      mockInvitationService.createInvitation.mockResolvedValue({
        invitation: mockInvitation,
        emailSent: true,
      } as unknown as Awaited<ReturnType<typeof mockInvitationService.createInvitation>>);

      const response = await request(app)
        .post(`/api/v1/teams/${TEST_TEAM_ID}/invitations`)
        .send({ name: 'Jane Hooper', email: 'jane@example.com', jerseyNumber: 7 });

      expect(response.status).toBe(201);
      expect(response.body.invitation).not.toHaveProperty('token');
      expect(mockInvitationService.createInvitation).toHaveBeenCalledWith(
        TEST_TEAM_ID,
        expect.objectContaining({ name: 'Jane Hooper', email: 'jane@example.com', jerseyNumber: 7 }),
        TEST_USER_ID
      );
    });

    it('should return 400 when playerId and email are both supplied', async () => {
      const response = await request(app)
        .post(`/api/v1/teams/${TEST_TEAM_ID}/invitations`)
        .send({ playerId: TEST_PLAYER_ID, name: 'Jane', email: 'jane@example.com' });

      expect(response.status).toBe(400);
      expect(mockInvitationService.createInvitation).not.toHaveBeenCalled();
    });

    it('should handle service errors', async () => {
      mockInvitationService.createInvitation.mockRejectedValue(
        new NotFoundError('Player not found')
      );

      const response = await request(app)
        .post(`/api/v1/teams/${TEST_TEAM_ID}/invitations`)
        .send({ playerId: TEST_PLAYER_ID });

      expect(response.status).toBe(404);
    });
  });

  describe('DELETE /api/v1/teams/:id/players/:playerId', () => {
    it('should remove a player from team successfully', async () => {
      mockTeamService.removePlayer.mockResolvedValue({ success: true });

      const response = await request(app)
        .delete(`/api/v1/teams/${TEST_TEAM_ID}/players/${TEST_PLAYER_ID}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Player removed from team successfully');
    });

    it('should return 404 for non-existent team or player', async () => {
      mockTeamService.removePlayer.mockRejectedValue(new NotFoundError('Not found'));

      const response = await request(app)
        .delete(`/api/v1/teams/${TEST_TEAM_ID}/players/00000000-0000-0000-0000-000000000000`);

      expect(response.status).toBe(404);
    });
  });

  describe('PATCH /api/v1/teams/:id/players/:playerId', () => {
    const mockTeamMember = {
      id: 'a7b8c9d0-e1f2-3456-7890-abcdef012345',
      teamId: TEST_TEAM_ID,
      playerId: TEST_PLAYER_ID,
      jerseyNumber: 23,
      position: 'Guard',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it('should update a team member successfully', async () => {
      mockTeamService.updateTeamMember.mockResolvedValue(mockTeamMember as unknown as Awaited<ReturnType<typeof mockTeamService.updateTeamMember>>);

      const response = await request(app)
        .patch(`/api/v1/teams/${TEST_TEAM_ID}/players/${TEST_PLAYER_ID}`)
        .send({ jerseyNumber: 23, position: 'Guard' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.teamMember.jerseyNumber).toBe(23);
    });

    it('should return 404 for non-existent team member', async () => {
      mockTeamService.updateTeamMember.mockRejectedValue(new NotFoundError('Not found'));

      const response = await request(app)
        .patch(`/api/v1/teams/${TEST_TEAM_ID}/players/00000000-0000-0000-0000-000000000000`)
        .send({ jerseyNumber: 23 });

      expect(response.status).toBe(404);
    });

    it('should accept jersey number 0 (boundary)', async () => {
      const memberWithZero = { ...mockTeamMember, jerseyNumber: 0 };
      mockTeamService.updateTeamMember.mockResolvedValue(memberWithZero as unknown as Awaited<ReturnType<typeof mockTeamService.updateTeamMember>>);

      const response = await request(app)
        .patch(`/api/v1/teams/${TEST_TEAM_ID}/players/${TEST_PLAYER_ID}`)
        .send({ jerseyNumber: 0 });

      expect(response.status).toBe(200);
      expect(response.body.teamMember.jerseyNumber).toBe(0);
    });

    it('should accept jersey number 99 (boundary)', async () => {
      const memberWith99 = { ...mockTeamMember, jerseyNumber: 99 };
      mockTeamService.updateTeamMember.mockResolvedValue(memberWith99 as unknown as Awaited<ReturnType<typeof mockTeamService.updateTeamMember>>);

      const response = await request(app)
        .patch(`/api/v1/teams/${TEST_TEAM_ID}/players/${TEST_PLAYER_ID}`)
        .send({ jerseyNumber: 99 });

      expect(response.status).toBe(200);
      expect(response.body.teamMember.jerseyNumber).toBe(99);
    });

    it('should reject jersey number 100 (out of range)', async () => {
      const response = await request(app)
        .patch(`/api/v1/teams/${TEST_TEAM_ID}/players/${TEST_PLAYER_ID}`)
        .send({ jerseyNumber: 100 });

      expect(response.status).toBe(400);
    });

    it('should reject negative jersey number', async () => {
      const response = await request(app)
        .patch(`/api/v1/teams/${TEST_TEAM_ID}/players/${TEST_PLAYER_ID}`)
        .send({ jerseyNumber: -1 });

      expect(response.status).toBe(400);
    });

    it('should reject non-integer jersey number', async () => {
      const response = await request(app)
        .patch(`/api/v1/teams/${TEST_TEAM_ID}/players/${TEST_PLAYER_ID}`)
        .send({ jerseyNumber: 23.5 });

      expect(response.status).toBe(400);
    });
  });

  // ============================================
  // Staff management routes (role matrix B2.3 / B2.7)
  // ============================================

  describe('GET /api/v1/teams/:teamId/staff', () => {
    const staffRow = {
      id: 'staff-1',
      teamId: TEST_TEAM_ID,
      userId: TEST_USER_ID,
      roleId: 'role-1',
      user: { id: TEST_USER_ID, name: 'Test User', email: 'test@example.com', isManaged: false },
      role: { id: 'role-1', teamId: TEST_TEAM_ID, type: 'HEAD_COACH', name: 'Head Coach' },
    };

    it('lists staff with user + role', async () => {
      mockTeamService.listStaff.mockResolvedValue([staffRow] as unknown as Awaited<ReturnType<typeof mockTeamService.listStaff>>);

      const response = await request(app).get(`/api/v1/teams/${TEST_TEAM_ID}/staff`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.staff).toHaveLength(1);
      expect(response.body.staff[0]).toMatchObject({
        userId: TEST_USER_ID,
        user: { id: TEST_USER_ID, name: 'Test User', email: 'test@example.com' },
        role: { type: 'HEAD_COACH', name: 'Head Coach' },
      });
      expect(mockTeamService.listStaff).toHaveBeenCalledWith(TEST_TEAM_ID, TEST_USER_ID);
    });

    it('passes through an email-less list unchanged (non-manager view)', async () => {
      const { user, ...rest } = staffRow;
      mockTeamService.listStaff.mockResolvedValue([
        { ...rest, user: { id: user.id, name: user.name, isManaged: false } },
      ] as unknown as Awaited<ReturnType<typeof mockTeamService.listStaff>>);

      const response = await request(app).get(`/api/v1/teams/${TEST_TEAM_ID}/staff`);

      expect(response.status).toBe(200);
      expect(response.body.staff[0].user).not.toHaveProperty('email');
    });

    it('returns 400 for a non-UUID teamId', async () => {
      const response = await request(app).get('/api/v1/teams/not-a-uuid/staff');

      expect(response.status).toBe(400);
      expect(mockTeamService.listStaff).not.toHaveBeenCalled();
    });

    it('returns 403 for an outsider', async () => {
      mockTeamService.listStaff.mockRejectedValue(new ForbiddenError('You do not have access to this team'));

      const response = await request(app).get(`/api/v1/teams/${TEST_TEAM_ID}/staff`);

      expect(response.status).toBe(403);
    });

    it('returns 404 for a missing team', async () => {
      mockTeamService.listStaff.mockRejectedValue(new NotFoundError('Team not found'));

      const response = await request(app).get(`/api/v1/teams/${TEST_TEAM_ID}/staff`);

      expect(response.status).toBe(404);
    });

    it('returns 500 on unexpected errors', async () => {
      mockTeamService.listStaff.mockRejectedValue(new Error('boom'));

      const response = await request(app).get(`/api/v1/teams/${TEST_TEAM_ID}/staff`);

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Failed to list team staff');
    });
  });

  describe('GET /api/v1/teams/:teamId/roles', () => {
    it('lists role definitions with permission flags', async () => {
      mockTeamService.getTeamRoles.mockResolvedValue([
        {
          id: 'role-1', teamId: TEST_TEAM_ID, type: 'HEAD_COACH', name: 'Head Coach', description: null,
          canManageTeam: true, canManageRoster: true, canTrackStats: true, canViewStats: true, canShareStats: true,
        },
      ] as unknown as Awaited<ReturnType<typeof mockTeamService.getTeamRoles>>);

      const response = await request(app).get(`/api/v1/teams/${TEST_TEAM_ID}/roles`);

      expect(response.status).toBe(200);
      expect(response.body.roles[0]).toMatchObject({ type: 'HEAD_COACH', canManageTeam: true });
      expect(mockTeamService.getTeamRoles).toHaveBeenCalledWith(TEST_TEAM_ID, TEST_USER_ID);
    });

    it('returns 403 when the caller cannot access the team', async () => {
      mockTeamService.getTeamRoles.mockRejectedValue(new ForbiddenError('You do not have access to this team'));

      const response = await request(app).get(`/api/v1/teams/${TEST_TEAM_ID}/roles`);

      expect(response.status).toBe(403);
    });

    it('returns 500 on unexpected errors', async () => {
      mockTeamService.getTeamRoles.mockRejectedValue(new Error('boom'));

      const response = await request(app).get(`/api/v1/teams/${TEST_TEAM_ID}/roles`);

      expect(response.status).toBe(500);
    });
  });

  describe('POST /api/v1/teams/:teamId/staff', () => {
    const created = {
      id: 'staff-2',
      teamId: TEST_TEAM_ID,
      userId: TEST_PLAYER_ID,
      roleId: 'role-2',
      user: { id: TEST_PLAYER_ID, name: 'New Coach', email: 'new@example.com', isManaged: false },
      role: { id: 'role-2', type: 'ASSISTANT_COACH', name: 'Assistant Coach' },
    };

    it('adds staff by userId and invalidates the ADDED user\'s usage cache', async () => {
      mockTeamService.addStaffMember.mockResolvedValue(created as unknown as Awaited<ReturnType<typeof mockTeamService.addStaffMember>>);

      const response = await request(app)
        .post(`/api/v1/teams/${TEST_TEAM_ID}/staff`)
        .send({ userId: TEST_PLAYER_ID, roleType: 'ASSISTANT_COACH' });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.staff).toMatchObject({ userId: TEST_PLAYER_ID, role: { type: 'ASSISTANT_COACH' } });
      expect(mockTeamService.addStaffMember).toHaveBeenCalledWith(
        TEST_TEAM_ID,
        { userId: TEST_PLAYER_ID, roleType: 'ASSISTANT_COACH' },
        TEST_USER_ID
      );
      expect(invalidateUsage).toHaveBeenCalledWith(TEST_PLAYER_ID);
    });

    it('adds staff by email', async () => {
      mockTeamService.addStaffMember.mockResolvedValue(created as unknown as Awaited<ReturnType<typeof mockTeamService.addStaffMember>>);

      const response = await request(app)
        .post(`/api/v1/teams/${TEST_TEAM_ID}/staff`)
        .send({ email: 'new@example.com', roleType: 'TEAM_MANAGER' });

      expect(response.status).toBe(201);
      expect(mockTeamService.addStaffMember).toHaveBeenCalledWith(
        TEST_TEAM_ID,
        { email: 'new@example.com', roleType: 'TEAM_MANAGER' },
        TEST_USER_ID
      );
    });

    it('returns 400 when neither userId nor email is given', async () => {
      const response = await request(app)
        .post(`/api/v1/teams/${TEST_TEAM_ID}/staff`)
        .send({ roleType: 'HEAD_COACH' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('exactly one of userId or email');
      expect(mockTeamService.addStaffMember).not.toHaveBeenCalled();
    });

    it('returns 400 for an invalid roleType (CUSTOM / role names are not assignable here)', async () => {
      const response = await request(app)
        .post(`/api/v1/teams/${TEST_TEAM_ID}/staff`)
        .send({ userId: TEST_PLAYER_ID, roleType: 'Head Coach' });

      expect(response.status).toBe(400);
      expect(mockTeamService.addStaffMember).not.toHaveBeenCalled();
    });

    it('returns 403 when an ASSISTANT coach tries to add staff (B2.3)', async () => {
      mockTeamService.addStaffMember.mockRejectedValue(
        new ForbiddenError('You do not have permission to manage team staff')
      );

      const response = await request(app)
        .post(`/api/v1/teams/${TEST_TEAM_ID}/staff`)
        .send({ userId: TEST_PLAYER_ID, roleType: 'TEAM_MANAGER' });

      expect(response.status).toBe(403);
      expect(invalidateUsage).not.toHaveBeenCalled();
    });

    it('returns 404 when the email does not belong to an existing user (never creates users)', async () => {
      mockTeamService.addStaffMember.mockRejectedValue(new NotFoundError('User not found'));

      const response = await request(app)
        .post(`/api/v1/teams/${TEST_TEAM_ID}/staff`)
        .send({ email: 'nobody@example.com', roleType: 'TEAM_MANAGER' });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('User not found');
    });

    it('returns 400 when the user is already staff', async () => {
      mockTeamService.addStaffMember.mockRejectedValue(
        new BadRequestError('User is already a staff member of this team')
      );

      const response = await request(app)
        .post(`/api/v1/teams/${TEST_TEAM_ID}/staff`)
        .send({ userId: TEST_PLAYER_ID, roleType: 'TEAM_MANAGER' });

      expect(response.status).toBe(400);
    });

    it('returns 500 on unexpected errors', async () => {
      mockTeamService.addStaffMember.mockRejectedValue(new Error('boom'));

      const response = await request(app)
        .post(`/api/v1/teams/${TEST_TEAM_ID}/staff`)
        .send({ userId: TEST_PLAYER_ID, roleType: 'TEAM_MANAGER' });

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Failed to add team staff');
    });
  });

  describe('PATCH /api/v1/teams/:teamId/staff/:userId', () => {
    it('changes the staff member\'s role', async () => {
      mockTeamService.changeStaffRole.mockResolvedValue({
        id: 'staff-2', teamId: TEST_TEAM_ID, userId: TEST_PLAYER_ID, roleId: 'role-3',
        role: { id: 'role-3', type: 'TEAM_MANAGER', name: 'Team Manager' },
      } as unknown as Awaited<ReturnType<typeof mockTeamService.changeStaffRole>>);

      const response = await request(app)
        .patch(`/api/v1/teams/${TEST_TEAM_ID}/staff/${TEST_PLAYER_ID}`)
        .send({ roleType: 'TEAM_MANAGER' });

      expect(response.status).toBe(200);
      expect(response.body.staff.role.type).toBe('TEAM_MANAGER');
      expect(mockTeamService.changeStaffRole).toHaveBeenCalledWith(
        TEST_TEAM_ID, TEST_PLAYER_ID, 'TEAM_MANAGER', TEST_USER_ID
      );
    });

    it('returns 400 for a missing/invalid roleType', async () => {
      const response = await request(app)
        .patch(`/api/v1/teams/${TEST_TEAM_ID}/staff/${TEST_PLAYER_ID}`)
        .send({});

      expect(response.status).toBe(400);
      expect(mockTeamService.changeStaffRole).not.toHaveBeenCalled();
    });

    it('returns 400 for a non-UUID userId param', async () => {
      const response = await request(app)
        .patch(`/api/v1/teams/${TEST_TEAM_ID}/staff/not-a-uuid`)
        .send({ roleType: 'TEAM_MANAGER' });

      expect(response.status).toBe(400);
      expect(mockTeamService.changeStaffRole).not.toHaveBeenCalled();
    });

    it('returns 403 for an assistant coach', async () => {
      mockTeamService.changeStaffRole.mockRejectedValue(
        new ForbiddenError('You do not have permission to manage team staff')
      );

      const response = await request(app)
        .patch(`/api/v1/teams/${TEST_TEAM_ID}/staff/${TEST_PLAYER_ID}`)
        .send({ roleType: 'TEAM_MANAGER' });

      expect(response.status).toBe(403);
    });

    it('returns 400 when demoting the last head coach', async () => {
      mockTeamService.changeStaffRole.mockRejectedValue(
        new BadRequestError('Cannot remove the last Head Coach. Assign another Head Coach first.')
      );

      const response = await request(app)
        .patch(`/api/v1/teams/${TEST_TEAM_ID}/staff/${TEST_USER_ID}`)
        .send({ roleType: 'ASSISTANT_COACH' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('last Head Coach');
    });

    it('returns 404 when the target is not staff', async () => {
      mockTeamService.changeStaffRole.mockRejectedValue(
        new NotFoundError('User is not a staff member of this team')
      );

      const response = await request(app)
        .patch(`/api/v1/teams/${TEST_TEAM_ID}/staff/${TEST_PLAYER_ID}`)
        .send({ roleType: 'TEAM_MANAGER' });

      expect(response.status).toBe(404);
    });

    it('returns 500 on unexpected errors', async () => {
      mockTeamService.changeStaffRole.mockRejectedValue(new Error('boom'));

      const response = await request(app)
        .patch(`/api/v1/teams/${TEST_TEAM_ID}/staff/${TEST_PLAYER_ID}`)
        .send({ roleType: 'TEAM_MANAGER' });

      expect(response.status).toBe(500);
    });
  });

  describe('DELETE /api/v1/teams/:teamId/staff/:userId', () => {
    it('removes a staff member and invalidates the REMOVED user\'s usage cache', async () => {
      mockTeamService.removeStaffMember.mockResolvedValue({ success: true });

      const response = await request(app)
        .delete(`/api/v1/teams/${TEST_TEAM_ID}/staff/${TEST_PLAYER_ID}`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true, message: 'Staff member removed successfully' });
      expect(mockTeamService.removeStaffMember).toHaveBeenCalledWith(TEST_TEAM_ID, TEST_PLAYER_ID, TEST_USER_ID);
      expect(invalidateUsage).toHaveBeenCalledWith(TEST_PLAYER_ID);
    });

    it('lets a staff member remove themselves (self path is decided by the service)', async () => {
      mockTeamService.removeStaffMember.mockResolvedValue({ success: true });

      const response = await request(app)
        .delete(`/api/v1/teams/${TEST_TEAM_ID}/staff/${TEST_USER_ID}`);

      expect(response.status).toBe(200);
      expect(mockTeamService.removeStaffMember).toHaveBeenCalledWith(TEST_TEAM_ID, TEST_USER_ID, TEST_USER_ID);
      expect(invalidateUsage).toHaveBeenCalledWith(TEST_USER_ID);
    });

    it('returns 400 when removing the last head coach', async () => {
      mockTeamService.removeStaffMember.mockRejectedValue(
        new BadRequestError('Cannot remove the last Head Coach. Assign another Head Coach first.')
      );

      const response = await request(app)
        .delete(`/api/v1/teams/${TEST_TEAM_ID}/staff/${TEST_USER_ID}`);

      expect(response.status).toBe(400);
      expect(invalidateUsage).not.toHaveBeenCalled();
    });

    it('returns 403 when an assistant coach removes someone else', async () => {
      mockTeamService.removeStaffMember.mockRejectedValue(
        new ForbiddenError('You do not have permission to manage team staff')
      );

      const response = await request(app)
        .delete(`/api/v1/teams/${TEST_TEAM_ID}/staff/${TEST_PLAYER_ID}`);

      expect(response.status).toBe(403);
    });

    it('returns 404 when the target is not staff', async () => {
      mockTeamService.removeStaffMember.mockRejectedValue(
        new NotFoundError('User is not a staff member of this team')
      );

      const response = await request(app)
        .delete(`/api/v1/teams/${TEST_TEAM_ID}/staff/${TEST_PLAYER_ID}`);

      expect(response.status).toBe(404);
    });

    it('returns 400 for a non-UUID userId param', async () => {
      const response = await request(app)
        .delete(`/api/v1/teams/${TEST_TEAM_ID}/staff/not-a-uuid`);

      expect(response.status).toBe(400);
      expect(mockTeamService.removeStaffMember).not.toHaveBeenCalled();
    });

    it('returns 500 on unexpected errors', async () => {
      mockTeamService.removeStaffMember.mockRejectedValue(new Error('boom'));

      const response = await request(app)
        .delete(`/api/v1/teams/${TEST_TEAM_ID}/staff/${TEST_PLAYER_ID}`);

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Failed to remove team staff');
    });
  });
});

afterAll((done) => {
  if (httpServer) {
    httpServer.close(() => done());
  } else {
    done();
  }
});
