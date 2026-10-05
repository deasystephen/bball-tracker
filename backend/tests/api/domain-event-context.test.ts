/**
 * A domain event logged from inside a service carries the caller's `userId`
 * and the request's `requestId` with no explicit context (#617, #763).
 *
 * Production wiring under test, none of it mocked: `requestContext` opens the
 * AsyncLocalStorage store, the real `authenticate` adds `userId` to it, and
 * `utils/logger.ts` merges the store into the line it writes. Only the token
 * check (`WorkOSService.verifyToken`), Prisma (shared mock) and the service
 * method are stubbed; the service stub logs the way a real service does, with
 * ids only. The line is read from `console.log`, because the merge happens
 * inside the logger, after `logger.info` is called.
 */

import request from 'supertest';
import { app } from '../../src/index';
import { TeamService } from '../../src/services/team-service';
import { WorkOSService, type VerifiedToken } from '../../src/services/workos-service';
import { logger } from '../../src/utils/logger';
import { mockPrisma } from '../setup';
import { authUser, devToken } from '../support/auth-fixtures';
import { parseLogLines, type LogLine } from '../support/log-lines';

jest.mock('../../src/services/team-service');
const mockTeamService = TeamService as jest.Mocked<typeof TeamService>;

const USER_ID = 'a1b2c3d4-e5f6-4890-a234-567890abcdef';
const TEAM_ID = 'b2c3d4e5-f6a7-4901-a345-67890abcdef0';
const DOMAIN_EVENT = 'Domain event from a service';
const verified: VerifiedToken = { id: 'workos_123', expiresAt: Date.now() + 60_000 };

const dbUser = authUser({ id: USER_ID });

function domainEventLines(spy: jest.SpyInstance): LogLine[] {
  return parseLogLines(spy).filter((line) => line.message === DOMAIN_EVENT);
}

describe('domain-event log context', () => {
  let consoleSpy: jest.SpyInstance;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    mockPrisma.user.findUnique.mockResolvedValue(dbUser);
    mockTeamService.listTeams.mockImplementation(async (query) => {
      logger.info(DOMAIN_EVENT, { teamId: TEAM_ID });
      return { teams: [], total: 0, limit: query.limit, offset: query.offset };
    });
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    jest.restoreAllMocks();
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('carries userId and requestId after a WorkOS token resolves', async () => {
    jest.spyOn(WorkOSService, 'verifyToken').mockResolvedValue(verified);

    const res = await request(app)
      .get('/api/v1/teams')
      .set('Authorization', 'Bearer valid-token')
      .set('X-Request-Id', 'req-workos');

    expect(res.status).toBe(200);
    expect(domainEventLines(consoleSpy)).toEqual([
      expect.objectContaining({ requestId: 'req-workos', userId: USER_ID, teamId: TEAM_ID }),
    ]);
  });

  it('carries userId and requestId after a dev token resolves', async () => {
    process.env.NODE_ENV = 'development';
    const verifySpy = jest.spyOn(WorkOSService, 'verifyToken');
    const token = devToken({ userId: USER_ID });

    const res = await request(app)
      .get('/api/v1/teams')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Request-Id', 'req-dev');

    expect(res.status).toBe(200);
    expect(verifySpy).not.toHaveBeenCalled();
    expect(domainEventLines(consoleSpy)).toEqual([
      expect.objectContaining({ requestId: 'req-dev', userId: USER_ID, teamId: TEAM_ID }),
    ]);
  });

  it('does not leak one request\'s userId into a later unauthenticated request', async () => {
    jest.spyOn(WorkOSService, 'verifyToken').mockResolvedValue(verified);
    await request(app).get('/api/v1/teams').set('Authorization', 'Bearer valid-token');

    const refused = await request(app).get('/api/v1/teams').set('X-Request-Id', 'req-anon');
    expect(refused.status).toBe(401);

    const lines = parseLogLines(consoleSpy).filter((line) => line.requestId === 'req-anon');
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toHaveProperty('userId');
    }
  });
});
