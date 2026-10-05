/**
 * API tests for POST /api/v1/auth/dev-login (development-only route).
 *
 * Local development and the Maestro flows sign in through this route
 * (`mobile/app/login.tsx` reads `{ accessToken, user }`), so its 400 / 404 /
 * 200 / 500 contract is pinned here (#692).
 *
 * The route is mounted only when NODE_ENV is `development` while
 * `src/api/auth/routes.ts` evaluates, so the app is loaded with a dynamic
 * import after the env is set, and the env is restored afterwards.
 */

import express, { type Express } from 'express';
import request from 'supertest';
import prisma from '../../src/models';

jest.mock('../../src/services/workos-service');

jest.mock('../../src/models', () => ({
  user: {
    findFirst: jest.fn(),
  },
  leagueAdmin: {
    findMany: jest.fn(),
  },
  guardian: {
    findMany: jest.fn(),
  },
}));

const mockPrisma = prisma as jest.Mocked<typeof prisma>;

const USER_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

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
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue({
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
    expect(mockPrisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ notifyOnReplies: true }),
      })
    );
    expect(response.body.accessToken).toMatch(/^dev_/);
  });

  it('returns 404 for an unknown or tombstoned email, looking up live rows only (#444)', async () => {
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue(null);

    const response = await request(app)
      .post('/api/v1/auth/dev-login')
      .send({ email: 'nobody@example.test' });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: 'User not found',
      hint: 'List the available test users with GET /api/v1/auth/dev-users',
    });
    expect(mockPrisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: { equals: 'nobody@example.test', mode: 'insensitive' }, deletedAt: null },
      })
    );
  });

  it('finds a stored lower-case address from a mixed-case email, through emailEquals', async () => {
    // A mocked lookup cannot see how the filter compiles; it pins that the
    // route asks case-insensitively and escapes LIKE pattern characters, the
    // `emailEquals` shape proven against Postgres in email-match.db.test.ts.
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue({
      id: USER_ID,
      email: 'frank_vogel@example.test',
      name: 'Frank Vogel',
      role: 'COACH',
      profilePictureUrl: null,
      notifyOnReplies: true,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const response = await request(app)
      .post('/api/v1/auth/dev-login')
      .send({ email: 'Frank_Vogel@Example.Test' });

    expect(response.status).toBe(200);
    expect(response.body.user.id).toBe(USER_ID);
    expect(mockPrisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: { equals: 'Frank\\_Vogel@Example.Test', mode: 'insensitive' }, deletedAt: null },
      })
    );
  });

  it('returns the session user and a dev_ token whose payload names the user', async () => {
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue({
      id: USER_ID,
      email: 'frank.vogel@example.test',
      name: 'Frank Vogel',
      role: 'COACH',
      profilePictureUrl: null,
      notifyOnReplies: true,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    (mockPrisma.leagueAdmin.findMany as jest.Mock).mockResolvedValue([{ leagueId: 'league-a' }]);
    const before = Date.now();

    const response = await request(app)
      .post('/api/v1/auth/dev-login')
      .send({ email: 'frank.vogel@example.test' });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.user).toEqual(
      expect.objectContaining({
        id: USER_ID,
        email: 'frank.vogel@example.test',
        name: 'Frank Vogel',
        role: 'COACH',
        leagueAdminOf: ['league-a'],
        guardianOf: [],
      })
    );

    const accessToken: string = response.body.accessToken;
    expect(accessToken).toMatch(/^dev_/);
    const payload = JSON.parse(Buffer.from(accessToken.slice('dev_'.length), 'base64').toString('utf8'));
    expect(payload).toEqual({ userId: USER_ID, email: 'frank.vogel@example.test', exp: expect.any(Number) });
    expect(payload.exp).toBeGreaterThan(before);
  });

  it('trims the email before the lookup', async () => {
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue(null);

    await request(app).post('/api/v1/auth/dev-login').send({ email: '  coach@example.test ' });

    expect(mockPrisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: { equals: 'coach@example.test', mode: 'insensitive' }, deletedAt: null },
      })
    );
  });

  it.each([
    ['a missing body', undefined, 'Email is required'],
    ['a missing email', {}, 'Email is required'],
    ['an empty email', { email: '' }, 'Email is required'],
    ['a whitespace-only email', { email: '   ' }, 'Email is required'],
    ['a numeric email', { email: 1 }, 'Email must be a string'],
    ['an object email (would act as a Prisma filter)', { email: { contains: 'a' } }, 'Email must be a string'],
    ['a 255-character email', { email: `${'a'.repeat(242)}@example.test` }, 'Email is too long'],
  ])('returns 400 for %s without touching the database', async (_label, body, message) => {
    const req = request(app).post('/api/v1/auth/dev-login');
    const response = body === undefined ? await req : await req.send(body);

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: message });
    expect(mockPrisma.user.findFirst).not.toHaveBeenCalled();
  });

  it('returns 500 when the lookup fails', async () => {
    (mockPrisma.user.findFirst as jest.Mock).mockRejectedValue(new Error('connection refused'));

    const response = await request(app)
      .post('/api/v1/auth/dev-login')
      .send({ email: 'coach@example.test' });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Dev login failed' });
  });
});

describe('POST /api/v1/auth/dev-login outside development', () => {
  it.each([['test'], [undefined]])('is not mounted when NODE_ENV is %s', async (nodeEnv) => {
    const previousEnv = process.env.NODE_ENV;
    let app: Express | undefined;
    if (nodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = nodeEnv;
    }
    try {
      await jest.isolateModulesAsync(async () => {
        const { default: router } = await import('../../src/api/auth/routes');
        app = express();
        app.use(express.json());
        app.use('/api/v1/auth', router);
      });
    } finally {
      process.env.NODE_ENV = previousEnv;
    }

    // An empty body: a mounted route answers 400, so only Express's own
    // fallthrough produces this 404 (the isolated registry has its own Prisma
    // mock, so a lookup-based 404 would prove nothing).
    const response = await request(app as Express).post('/api/v1/auth/dev-login').send({});

    expect(response.status).toBe(404);
    expect(response.text).toContain('Cannot POST /api/v1/auth/dev-login');
  });
});
