/**
 * API tests for POST /api/v1/auth/dev-login (development-only route).
 *
 * The route is mounted only when NODE_ENV is `development` while
 * `src/api/auth/routes.ts` evaluates, so the app is loaded with a dynamic
 * import after the env is set, and the env is restored afterwards.
 */

import request from 'supertest';
import prisma from '../../src/models';

jest.mock('../../src/services/workos-service');

jest.mock('../../src/models', () => ({
  user: {
    findUnique: jest.fn(),
  },
  leagueAdmin: {
    findMany: jest.fn(),
  },
  guardian: {
    findMany: jest.fn(),
  },
}));

const mockPrisma = prisma as jest.Mocked<typeof prisma>;

type AppModule = typeof import('../../src/index');

describe('POST /api/v1/auth/dev-login', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  let app: AppModule['app'];
  let httpServer: AppModule['httpServer'];

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    ({ app, httpServer } = await import('../../src/index'));
  });

  afterAll((done) => {
    process.env.NODE_ENV = originalNodeEnv;
    if (httpServer?.listening) {
      httpServer.close(() => done());
    } else {
      done();
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (mockPrisma.leagueAdmin.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.guardian.findMany as jest.Mock).mockResolvedValue([]);
  });

  it('carries the stored notifyOnReplies opt-out in the session user (#768)', async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({
      id: 'user-1',
      email: 'coach@example.test',
      name: 'Coach',
      role: 'COACH',
      notifyOnReplies: false,
    });

    const response = await request(app)
      .post('/api/v1/auth/dev-login')
      .send({ email: 'coach@example.test' });

    expect(response.status).toBe(200);
    expect(response.body.user).toEqual(
      expect.objectContaining({
        id: 'user-1',
        notifyOnReplies: false,
        leagueAdminOf: [],
        guardianOf: [],
      })
    );
    // The select must name the flag, or the spread never carries it.
    expect(mockPrisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ notifyOnReplies: true }),
      })
    );
    expect(response.body.accessToken).toMatch(/^dev_/);
  });

  it('returns 404 for an unknown email', async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(null);

    const response = await request(app)
      .post('/api/v1/auth/dev-login')
      .send({ email: 'nobody@example.test' });

    expect(response.status).toBe(404);
  });
});
