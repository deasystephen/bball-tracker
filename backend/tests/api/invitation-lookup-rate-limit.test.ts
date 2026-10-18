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

// The test sends INVITATION_LOOKUP_IP_MAX_PER_15_MIN + 1 requests (601 today).
// Each supertest call opens its own server and socket, so strictly sequential
// calls took 2-11 s on a saturated machine and exceeded the 10 s default (#804).
// The first 600 lookups are order-independent, so they go out in concurrent
// chunks; the final one is sent alone to prove the 429. The timeout stays as a
// safety margin: 150 ms per request, derived from the count so a changed
// ceiling rescales it, instead of raising the global timeout in jest.config.js.
// Wall time with chunking: about 0.27 s at load average 8 (was 2-11 s sequential).
const PER_REQUEST_BUDGET_MS = 150;
const TEST_TIMEOUT_MS = (INVITATION_LOOKUP_IP_MAX_PER_15_MIN + 1) * PER_REQUEST_BUDGET_MS;
const CHUNK_SIZE = 50;

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
    for (let start = 0; start < INVITATION_LOOKUP_IP_MAX_PER_15_MIN; start += CHUNK_SIZE) {
      const end = Math.min(start + CHUNK_SIZE, INVITATION_LOOKUP_IP_MAX_PER_15_MIN);
      const statuses = await Promise.all(
        Array.from({ length: end - start }, async (_, k) => {
          const res = await request(app).get(`/api/v1/invitations/by-token/ssr-egress-${start + k}-abcdefgh`);
          return res.status;
        })
      );
      expect(statuses.every((status) => status === 200)).toBe(true);
    }

    const blocked = await request(app).get('/api/v1/invitations/by-token/one-token-too-many-abcdefgh');
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: 'Too many invitation lookups, please try again later' });
    expect(mockInvitationService.getInvitationByToken).toHaveBeenCalledTimes(INVITATION_LOOKUP_IP_MAX_PER_15_MIN);
  }, TEST_TIMEOUT_MS);
});
