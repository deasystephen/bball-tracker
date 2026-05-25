/**
 * Integration tests — verify that HTTP actions trigger email sends via Mailer.
 *
 * Strategy: real service code runs; Prisma and push notifications are mocked
 * globally (setup.ts / jest.mock).  The mailer module is mocked so we can
 * assert send() calls without hitting real AWS SES.
 */

import request from 'supertest';
import { app, httpServer } from '../../src/index';
import { mockPrisma } from '../setup';
import {
  createCoach,
  createPlayer,
  createTeam,
  createLeague,
  createSeason,
  createTeamRole,
  createTeamStaff,
} from '../factories';

const TEST_USER_ID = 'a1b2c3d4-e5f6-4890-a234-567890abcdef';
const TEST_TEAM_ID = 'b2c3d4e5-f6a7-4901-a345-67890abcdef0';
const TEST_GAME_ID = 'c3d4e5f6-a7b8-4012-a456-7890abcdef01';

// ─── Mocks ──────────────────────────────────────────────────────────────────

jest.mock('../../src/api/auth/middleware', () => ({
  authenticate: jest.fn((req, _res, next) => {
    req.user = {
      id: TEST_USER_ID,
      email: 'coach@example.com',
      name: 'Coach Test',
      role: 'COACH',
    };
    next();
  }),
  requireRole: jest.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));

// Mock the mailer so we can spy without hitting AWS SES
jest.mock('../../src/services/mailer', () => ({
  mailer: { send: jest.fn().mockResolvedValue({ messageId: 'test-msg-id' }) },
  FakeMailer: jest.fn(),
}));

// Retrieve the mocked send reference after hoisting completes
const mockMailerSend = (jest.requireMock('../../src/services/mailer') as unknown as { mailer: { send: jest.Mock } }).mailer.send;

// Suppress push notifications (tested separately in notification tests)
jest.mock('../../src/services/notification-service', () => ({
  NotificationService: { sendToTeam: jest.fn().mockResolvedValue(undefined) },
}));

afterAll(() => {
  httpServer.close();
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function setupCoachWithTeam() {
  const coach = createCoach({ id: TEST_USER_ID, email: 'coach@example.com' });
  const league = createLeague();
  const season = createSeason({ leagueId: league.id });
  const team = createTeam({ id: TEST_TEAM_ID, seasonId: season.id });
  const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
  const coachStaff = createTeamStaff({
    teamId: team.id,
    userId: coach.id,
    roleId: headCoachRole.id,
  });
  return { coach, league, season, team, headCoachRole, coachStaff };
}

// ─── Announcement email ──────────────────────────────────────────────────────

describe('POST /api/v1/teams/:teamId/announcements — email', () => {
  it('sends announcement emails to team members', async () => {
    const { coach, team, headCoachRole, coachStaff } = setupCoachWithTeam();
    const player = createPlayer({ email: 'player@example.com' });

    (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
      ...team,
      members: [{ player: { id: player.id, name: player.name, email: player.email } }],
    });
    (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([
      { ...coachStaff, role: headCoachRole },
    ]);
    (mockPrisma.announcement.create as jest.Mock).mockResolvedValue({
      id: 'ann-1',
      teamId: team.id,
      authorId: coach.id,
      title: 'Gym change',
      body: 'Practice is at Gym B now.',
      createdAt: new Date(),
      author: { id: coach.id, name: coach.name, email: coach.email },
    });

    const response = await request(app)
      .post(`/api/v1/teams/${TEST_TEAM_ID}/announcements`)
      .send({ title: 'Gym change', body: 'Practice is at Gym B now.' });

    expect(response.status).toBe(201);

    // Allow fire-and-forget promises to settle
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockMailerSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to: player.email,
        metadata: expect.objectContaining({ event_type: 'announcement.created' }),
      })
    );
  });

  it('does not send emails when team has no members with email', async () => {
    const { team, headCoachRole, coachStaff, coach } = setupCoachWithTeam();

    (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
      ...team,
      // managed player with no email
      members: [{ player: { id: 'managed-1', name: 'Kid', email: null } }],
    });
    (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([
      { ...coachStaff, role: headCoachRole },
    ]);
    (mockPrisma.announcement.create as jest.Mock).mockResolvedValue({
      id: 'ann-2',
      teamId: team.id,
      authorId: coach.id,
      title: 'Test',
      body: 'Test body.',
      createdAt: new Date(),
      author: { id: coach.id, name: coach.name, email: coach.email },
    });

    mockMailerSend.mockClear();

    await request(app)
      .post(`/api/v1/teams/${TEST_TEAM_ID}/announcements`)
      .send({ title: 'Test', body: 'Test body.' });

    await new Promise((resolve) => setImmediate(resolve));
    expect(mockMailerSend).not.toHaveBeenCalled();
  });
});

// ─── Invitation email ─────────────────────────────────────────────────────────

describe('POST /api/v1/teams/:teamId/invitations — email', () => {
  it('sends invitation email to invited player', async () => {
    const { coach, team, headCoachRole, coachStaff } = setupCoachWithTeam();
    // playerId must be a valid UUID to pass schema validation
    const player = createPlayer({ id: 'd4e5f6a7-b8c9-4123-a567-890abcdef012', email: 'player@example.com' });

    (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
    (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([
      { ...coachStaff, role: headCoachRole },
    ]);
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(player);
    (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);
    (mockPrisma.teamInvitation.findFirst as jest.Mock).mockResolvedValue(null);
    (mockPrisma.teamInvitation.create as jest.Mock).mockResolvedValue({
      id: 'inv-1',
      teamId: team.id,
      playerId: player.id,
      invitedById: coach.id,
      token: 'tok',
      status: 'PENDING',
      expiresAt: new Date(Date.now() + 7 * 86400000),
      message: 'Join us!',
      createdAt: new Date(),
      updatedAt: new Date(),
      team: { id: team.id, name: team.name, season: { id: 's1', name: 'Spring', league: { id: 'l1', name: 'League' } } },
      player: { id: player.id, name: player.name, email: player.email },
      invitedBy: { id: coach.id, name: coach.name, email: coach.email },
    });

    mockMailerSend.mockClear();

    const response = await request(app)
      .post(`/api/v1/teams/${TEST_TEAM_ID}/invitations`)
      .send({ playerId: player.id });

    expect(response.status).toBe(201);

    await new Promise((resolve) => setImmediate(resolve));

    expect(mockMailerSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to: player.email,
        metadata: expect.objectContaining({ event_type: 'invitation.created' }),
      })
    );
  });
});

// ─── RSVP email ───────────────────────────────────────────────────────────────

describe('POST /api/v1/games/:gameId/rsvp — email', () => {
  it('sends RSVP confirmation email to the player', async () => {
    const player = createPlayer({ id: TEST_USER_ID, email: 'player@example.com' });
    const { team } = setupCoachWithTeam();

    (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
      id: TEST_GAME_ID,
      teamId: team.id,
      opponent: 'Pistons',
      date: new Date('2026-06-15'),
      team: { name: team.name },
    });
    (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue({
      teamId: team.id,
      playerId: player.id,
    });
    (mockPrisma.gameRsvp.upsert as jest.Mock).mockResolvedValue({
      id: 'rsvp-1',
      gameId: TEST_GAME_ID,
      userId: player.id,
      status: 'YES',
      createdAt: new Date(),
      updatedAt: new Date(),
      user: { id: player.id, name: player.name, email: player.email },
    });

    mockMailerSend.mockClear();

    const response = await request(app)
      .post(`/api/v1/games/${TEST_GAME_ID}/rsvp`)
      .send({ status: 'YES' });

    expect(response.status).toBe(200);

    await new Promise((resolve) => setImmediate(resolve));

    expect(mockMailerSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to: player.email,
        metadata: expect.objectContaining({ event_type: 'rsvp.upserted' }),
      })
    );
  });
});
