/**
 * API test for DELETE /api/v1/leagues/:id/admins/:userId with the real
 * LeagueService (#1038).
 *
 * `tests/api/leagues.test.ts` mocks LeagueService wholesale. Here the request
 * runs validation -> route -> LeagueService.removeLeagueAdmin -> (mocked)
 * Prisma, the same path as production: the removal also cancels the PENDING
 * staff invitations the former admin sent on the league's teams where they no
 * longer manage staff. What Postgres does with the locks is covered by
 * `tests/integration/staff-invitation-followups.db.test.ts`.
 */

import request from 'supertest';
import { app, httpServer } from '../../src/index';
import { mockPrisma } from '../setup';

const SYS_ADMIN_ID = 'a1b2c3d4-e5f6-4890-a234-567890abcdef';
const FORMER_ADMIN_ID = 'c3d4e5f6-a7b8-4012-a456-7890abcdef01';
const LEAGUE_ID = 'league-1';
const TEAM_ID = 'b2c3d4e5-f6a7-4901-a345-67890abcdef0';

jest.mock('../../src/api/auth/middleware', () => ({
  authenticate: jest.fn((req, _res, next) => {
    req.user = {
      id: 'a1b2c3d4-e5f6-4890-a234-567890abcdef',
      email: 'admin@example.com',
      name: 'Ada Admin',
      role: 'ADMIN',
    };
    next();
  }),
}));

describe('DELETE /api/v1/leagues/:id/admins/:userId through the real LeagueService (#1038)', () => {
  beforeEach(() => {
    (mockPrisma.user.findUnique as jest.Mock).mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve(
        where.id === SYS_ADMIN_ID
          ? { id: SYS_ADMIN_ID, role: 'ADMIN', deletedAt: null }
          : { id: FORMER_ADMIN_ID, role: 'COACH', deletedAt: null }
      )
    );
    (mockPrisma.leagueAdmin.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });
    // After the delete: no admin row left, and no head-coach row on the team.
    (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({ season: { leagueId: LEAGUE_ID } });
    (mockPrisma.leagueAdmin.findUnique as jest.Mock).mockResolvedValue(null);
    (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(null);
  });

  it('answers 200 and cancels the former admin\'s pending staff invitations on the league\'s teams', async () => {
    (mockPrisma.staffInvitation.findMany as jest.Mock).mockResolvedValueOnce([{ teamId: TEAM_ID }]);
    (mockPrisma.staffInvitation.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

    const response = await request(app).delete(`/api/v1/leagues/${LEAGUE_ID}/admins/${FORMER_ADMIN_ID}`);

    expect(response.status).toBe(200);
    expect(mockPrisma.leagueAdmin.deleteMany).toHaveBeenCalledWith({
      where: { leagueId: LEAGUE_ID, userId: FORMER_ADMIN_ID },
    });
    expect(mockPrisma.staffInvitation.updateMany).toHaveBeenCalledWith({
      where: { teamId: TEAM_ID, invitedById: FORMER_ADMIN_ID, status: 'PENDING' },
      data: { status: 'CANCELLED' },
    });
  });

  it('answers 404 and cancels nothing when the user is not an admin of the league', async () => {
    (mockPrisma.leagueAdmin.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });

    const response = await request(app).delete(`/api/v1/leagues/${LEAGUE_ID}/admins/${FORMER_ADMIN_ID}`);

    expect(response.status).toBe(404);
    expect(mockPrisma.staffInvitation.updateMany).not.toHaveBeenCalled();
  });
});

afterAll((done) => {
  if (httpServer) {
    httpServer.close(() => done());
  } else {
    done();
  }
});
