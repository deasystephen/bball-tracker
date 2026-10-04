/**
 * #715: the routes that can end in an invitation email (invitations, Add
 * Player, guardian invite) are bounded per user (`inviteRateLimit`, 60/hour) and a Resend inside the per-recipient cooldown
 * answers 429 `resend_cooldown`. Through the real router chain (`src/index`).
 *
 * Its own file because the limiter's in-memory store is per module registry:
 * 60+ requests here would otherwise eat the global 100/min budget that the
 * rest of tests/api/teams.test.ts runs under.
 */

import request from 'supertest';
import { app, httpServer } from '../../src/index';
import { InvitationService } from '../../src/services/invitation-service';
import { GuardianService } from '../../src/services/guardian-service';
import { ResendCooldownError } from '../../src/utils/errors';

const TEAM_ID = 'b2c3d4e5-f6a7-4901-a345-67890abcdef0';
const PLAYER_ID = 'd4e5f6a7-b8c9-4123-a567-890abcdef012';

const mockAuthUser = {
  id: 'a1b2c3d4-e5f6-4890-a234-567890abcdef',
  email: 'coach@example.test',
  name: 'Coach',
  role: 'COACH',
  subscriptionTier: 'PREMIUM',
  subscriptionExpiresAt: null,
};

jest.mock('../../src/api/auth/middleware', () => ({
  authenticate: jest.fn((req, _res, next) => {
    req.user = { ...mockAuthUser };
    next();
  }),
}));
jest.mock('../../src/services/invitation-service');
jest.mock('../../src/services/guardian-service');

const mockInvitationService = InvitationService as jest.Mocked<typeof InvitationService>;
const mockGuardianService = GuardianService as jest.Mocked<typeof GuardianService>;

afterAll((done) => {
  // Never listening under supertest; close() reports that, which is fine.
  httpServer.close(() => done());
});

describe('invitation email limits (#715)', () => {
  beforeEach(() => {
    mockInvitationService.createInvitation.mockResolvedValue({
      invitation: { id: 'inv-1', teamId: TEAM_ID, playerId: PLAYER_ID, status: 'PENDING' },
      emailSent: true,
    } as unknown as Awaited<ReturnType<typeof InvitationService.createInvitation>>);
    mockInvitationService.addRosterPlayer.mockResolvedValue({
      rostered: true,
      invited: false,
      member: null,
      invitation: null,
      emails: {},
    } as unknown as Awaited<ReturnType<typeof InvitationService.addRosterPlayer>>);
    mockGuardianService.inviteGuardian.mockResolvedValue({
      id: 'ginv-1',
      emailSent: true,
    } as unknown as Awaited<ReturnType<typeof GuardianService.inviteGuardian>>);
  });

  it('answers 429 resend_cooldown with a DetailedError body when the service refuses a resend', async () => {
    mockAuthUser.id = 'e1e2e3e4-0000-4000-8000-000000000001';
    mockInvitationService.createInvitation.mockRejectedValueOnce(new ResendCooldownError(87));

    const res = await request(app)
      .post(`/api/v1/teams/${TEAM_ID}/invitations`)
      .send({ playerId: PLAYER_ID, supersede: true });

    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      error: 'An invitation was just sent to this player. Try again in 87 seconds.',
      code: 'resend_cooldown',
      retryAfterSeconds: 87,
    });
  });

  it('answers 429 resend_cooldown from Add Player too (re-adding the same address)', async () => {
    mockAuthUser.id = 'e1e2e3e4-0000-4000-8000-000000000004';
    mockInvitationService.addRosterPlayer.mockRejectedValueOnce(new ResendCooldownError(42));

    const res = await request(app)
      .post(`/api/v1/teams/${TEAM_ID}/players`)
      .send({ name: 'Jane', playerEmail: 'jane@example.test' });

    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ code: 'resend_cooldown', retryAfterSeconds: 42 });
  });

  it('caps one user at 60 sends an hour across the three routes, then 429 with RateLimit headers', async () => {
    mockAuthUser.id = 'e1e2e3e4-0000-4000-8000-000000000002';
    const send = (i: number): request.Test => {
      switch (i % 3) {
        case 0:
          return request(app).post(`/api/v1/teams/${TEAM_ID}/invitations`).send({ playerId: PLAYER_ID, supersede: true });
        case 1:
          return request(app).post(`/api/v1/teams/${TEAM_ID}/players`).send({ name: `Player ${i}` });
        default:
          return request(app)
            .post(`/api/v1/teams/${TEAM_ID}/members/${PLAYER_ID}/guardians`)
            .send({ email: `parent${i}@example.test`, relationship: 'MOTHER' });
      }
    };
    for (let i = 0; i < 60; i += 1) {
      const res = await send(i);
      expect(res.status).toBe(201);
    }

    const blocked = await request(app)
      .post(`/api/v1/teams/${TEAM_ID}/invitations`)
      .send({ playerId: PLAYER_ID, supersede: true });
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: 'Too many invitations sent, please try again later' });
    expect(blocked.headers['ratelimit-remaining']).toBe('0');
    expect(blocked.headers['ratelimit-limit']).toBe('60');

    const blockedAdd = await request(app).post(`/api/v1/teams/${TEAM_ID}/players`).send({ name: 'One more' });
    expect(blockedAdd.status).toBe(429);
    const blockedGuardian = await send(2);
    expect(blockedGuardian.status).toBe(429);
    expect(mockInvitationService.createInvitation).toHaveBeenCalledTimes(20);
    expect(mockGuardianService.inviteGuardian).toHaveBeenCalledTimes(20);

    // Another coach (same IP) has their own budget.
    mockAuthUser.id = 'e1e2e3e4-0000-4000-8000-000000000003';
    const other = await request(app)
      .post(`/api/v1/teams/${TEAM_ID}/invitations`)
      .send({ playerId: PLAYER_ID, supersede: true });
    expect(other.status).toBe(201);
  });
});
