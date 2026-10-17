/**
 * Route catch blocks answer through respondWithError (#831) and log at the
 * level of the status they answered (#656).
 *
 * Expected client outcomes (4xx) are `warn`; 5xx and unexpected exceptions are
 * `error`, so `service:bball-tracker-api @level:error` stays the on-call signal
 * (docs/architecture/backend-services.md#logging). Runs through the real
 * router chain with the services mocked, like every suite in tests/api/.
 */

import request from 'supertest';
import { app, httpServer } from '../../src/index';
import { TeamService } from '../../src/services/team-service';
import { CalendarService } from '../../src/services/calendar-service';
import { StatsExportService } from '../../src/services/stats-export-service';
import { ConflictError, ForbiddenError, NotFoundError, PaymentRequiredError } from '../../src/utils/errors';
import { logger } from '../../src/utils/logger';

const TEST_TEAM_ID = 'b2c3d4e5-f6a7-4901-a345-67890abcdef0';

jest.mock('../../src/api/auth/middleware', () => ({
  authenticate: jest.fn((req, _res, next) => {
    req.user = {
      id: 'a1b2c3d4-e5f6-4890-a234-567890abcdef',
      email: 'test@example.test',
      name: 'Test User',
      role: 'COACH',
      subscriptionTier: 'PREMIUM',
      subscriptionExpiresAt: null,
    };
    next();
  }),
}));

jest.mock('../../src/services/team-service');
jest.mock('../../src/services/calendar-service');
jest.mock('../../src/services/stats-export-service');

const mockTeamService = TeamService as jest.Mocked<typeof TeamService>;
const mockCalendarService = CalendarService as jest.Mocked<typeof CalendarService>;
const mockExport = StatsExportService as jest.Mocked<typeof StatsExportService>;
const TEST_GAME_ID = 'c3d4e5f6-a7b8-4012-a456-7890abcdef01';

describe('route catch log level (#656)', () => {
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
  });

  it('a 404 (unaffiliated caller on GET /teams/:id) logs at warn, never error', async () => {
    mockTeamService.getTeamById.mockRejectedValue(new NotFoundError('Team not found'));

    const res = await request(app).get(`/api/v1/teams/${TEST_TEAM_ID}`);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Team not found' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('Error getting team', { status: 404, error: 'Team not found' });
    expect(error).not.toHaveBeenCalled();
  });

  it('a 403 (revoked calendar feed token) logs at warn, never error', async () => {
    mockCalendarService.resolveToken.mockRejectedValue(new ForbiddenError('Calendar token revoked'));

    const res = await request(app).get(`/api/v1/teams/${TEST_TEAM_ID}/calendar.ics?token=revoked`);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Calendar token revoked' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('Error serving calendar feed', {
      status: 403,
      error: 'Calendar token revoked',
    });
    expect(error).not.toHaveBeenCalled();
  });

  it('an unexpected exception answers 500 and logs at error', async () => {
    mockTeamService.getTeamById.mockRejectedValue(new Error('connection reset'));

    const res = await request(app).get(`/api/v1/teams/${TEST_TEAM_ID}`);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to get team' });
    expect(error).toHaveBeenCalledWith('Error getting team', { status: 500, error: 'connection reset' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('any AppError is answered with its own status and message, logged at warn (#831)', async () => {
    // GET /teams/:id used to list only 400/403/404 and answer 500 for any other
    // AppError; respondWithError answers every AppError with its own status.
    mockTeamService.getTeamById.mockRejectedValue(new ConflictError('unexpected conflict'));

    const res = await request(app).get(`/api/v1/teams/${TEST_TEAM_ID}`);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'unexpected conflict' });
    expect(warn).toHaveBeenCalledWith('Error getting team', { status: 409, error: 'unexpected conflict' });
    expect(error).not.toHaveBeenCalled();
  });

  it('a DetailedError is answered with its body() (#831)', async () => {
    // A route that never listed PaymentRequiredError still answers the 402
    // upgrade_required payload the client renders as an upgrade CTA.
    mockTeamService.getTeamById.mockRejectedValue(
      new PaymentRequiredError({ feature: 'x', currentTier: 'FREE', requiredTier: 'PREMIUM' })
    );

    const res = await request(app).get(`/api/v1/teams/${TEST_TEAM_ID}`);

    expect(res.status).toBe(402);
    expect(res.body).toEqual({
      error: 'Upgrade required',
      code: 'upgrade_required',
      feature: 'x',
      currentTier: 'FREE',
      requiredTier: 'PREMIUM',
    });
    expect(warn).toHaveBeenCalledWith('Error getting team', { status: 402, error: 'Upgrade required' });
    expect(error).not.toHaveBeenCalled();
  });

  it('an export that fails after the response started keeps its error line and ends the response', async () => {
    // pipe() wrote the headers and part of the body, then threw: answering a
    // second time would throw ERR_HTTP_HEADERS_SENT and lose the log line.
    const stream = {
      on: jest.fn(),
      pipe: jest.fn((res: import('express').Response) => {
        res.writeHead(200, { 'Content-Type': 'text/csv' });
        res.write('a,b\n');
        throw new Error('pipe broke');
      }),
    };
    mockExport.exportGameEventsCsv.mockResolvedValue({
      stream,
      contentType: 'text/csv',
      filename: 'game.csv',
    } as unknown as Awaited<ReturnType<typeof StatsExportService.exportGameEventsCsv>>);

    const res = await request(app).get(`/api/v1/games/${TEST_GAME_ID}/export.csv`);

    expect(res.status).toBe(200);
    expect(error).toHaveBeenCalledWith('Error exporting game CSV', { streamed: true, status: 500, error: 'pipe broke' });
    expect(warn).not.toHaveBeenCalled();
  });
});

afterAll((done) => {
  if (httpServer) {
    httpServer.close(() => done());
  } else {
    done();
  }
});
