/**
 * #718: `GET /invitations/by-token/:token` is exempt from the global 100/min
 * IP limit (the SSR invite page calls it from one egress IP) but keeps its
 * own looser per-IP ceiling, so a loop of random tokens cannot reach the
 * database unbounded. Through the real router chain (`src/index`).
 *
 * Its own file because the limiter's in-memory store is per module registry:
 * exhausting the IP budget here would 429 every lookup test that follows.
 */

import request from 'supertest';
import { app } from '../../src/index';
import { InvitationService } from '../../src/services/invitation-service';
import { INVITATION_LOOKUP_IP_MAX_PER_15_MIN } from '../../src/api/middleware/rate-limit';

jest.mock('../../src/services/invitation-service');
jest.mock('../../src/services/guardian-service');

const mockInvitationService = InvitationService as jest.Mocked<typeof InvitationService>;

describe('public invitation lookup IP ceiling (#718)', () => {
  it('admits the SSR pattern well past 100/min, then answers 429 past its own ceiling', async () => {
    mockInvitationService.getInvitationByToken.mockResolvedValue({
      id: 'b2c3d4e5-f6a7-4901-a345-67890abcdef0',
      status: 'PENDING',
      teamName: 'Lakers',
      inviterName: 'Coach',
      inviterDeletedAt: null,
      position: null,
      jerseyNumber: null,
      message: null,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    } as unknown as Awaited<ReturnType<typeof InvitationService.getInvitationByToken>>);

    // Distinct tokens from one IP, as the web server would send them.
    for (let i = 0; i < INVITATION_LOOKUP_IP_MAX_PER_15_MIN; i += 1) {
      const res = await request(app).get(`/api/v1/invitations/by-token/ssr-egress-${i}-abcdefgh`);
      expect(res.status).toBe(200);
    }

    const blocked = await request(app).get('/api/v1/invitations/by-token/one-token-too-many-abcdefgh');
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: 'Too many invitation lookups, please try again later' });
    expect(mockInvitationService.getInvitationByToken).toHaveBeenCalledTimes(INVITATION_LOOKUP_IP_MAX_PER_15_MIN);
  });
});
