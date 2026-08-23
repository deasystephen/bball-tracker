/**
 * API tests for POST /api/v1/auth/logout (server-side session revocation, audit #51)
 *
 * `authenticate` is mocked so the tests can drive the bearer token value
 * directly; `WorkOSService` is mocked to observe revocation calls.
 */

import request from 'supertest';
import { app, httpServer } from '../../src/index';
import { WorkOSService } from '../../src/services/workos-service';

const TEST_USER_ID = 'a1b2c3d4-e5f6-4890-a234-567890abcdef';

jest.mock('../../src/api/auth/middleware', () => ({
  authenticate: jest.fn((req, res, next) => {
    const header = req.headers.authorization as string | undefined;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authorization token required' });
    }
    req.user = {
      id: TEST_USER_ID,
      email: 'test@example.com',
      name: 'Test User',
      role: 'PLAYER',
      subscriptionTier: 'FREE',
      subscriptionExpiresAt: null,
    };
    next();
  }),
  requireRole: jest.fn(() => (_req: unknown, _res: unknown, next: () => void): void => next()),
}));

jest.mock('../../src/services/workos-service');

jest.mock('../../src/utils/sentry', () => ({
  ...jest.requireActual('../../src/utils/sentry'),
  captureException: jest.fn(),
}));
import { captureException } from '../../src/utils/sentry';

const mockWorkOSService = WorkOSService as jest.Mocked<typeof WorkOSService>;
const mockCaptureException = captureException as jest.Mock;

describe('POST /api/v1/auth/logout', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('requires authentication', async () => {
    const res = await request(app).post('/api/v1/auth/logout');

    expect(res.status).toBe(401);
    expect(mockWorkOSService.revokeSession).not.toHaveBeenCalled();
  });

  it('revokes the WorkOS session named by the token sid', async () => {
    mockWorkOSService.verifyToken.mockResolvedValue({ id: 'workos-user-1', sessionId: 'session_abc', expiresAt: 9999999999 });
    mockWorkOSService.revokeSession.mockResolvedValue(undefined);

    const res = await request(app)
      .post('/api/v1/auth/logout')
      .set('Authorization', 'Bearer signed.jwt.token');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, revoked: true });
    expect(mockWorkOSService.verifyToken).toHaveBeenCalledWith('signed.jwt.token');
    expect(mockWorkOSService.revokeSession).toHaveBeenCalledWith('session_abc');
  });

  it('is a no-op for dev-login tokens', async () => {
    const res = await request(app)
      .post('/api/v1/auth/logout')
      .set('Authorization', 'Bearer dev_abc123');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, revoked: false });
    expect(mockWorkOSService.verifyToken).not.toHaveBeenCalled();
    expect(mockWorkOSService.revokeSession).not.toHaveBeenCalled();
  });

  it('returns revoked:false when the token carries no session id', async () => {
    mockWorkOSService.verifyToken.mockResolvedValue({ id: 'workos-user-1', expiresAt: 9999999999 });

    const res = await request(app)
      .post('/api/v1/auth/logout')
      .set('Authorization', 'Bearer signed.jwt.token');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, revoked: false });
    expect(mockWorkOSService.revokeSession).not.toHaveBeenCalled();
  });

  it('still returns 200 (revoked:false) and reports when WorkOS revocation fails', async () => {
    mockWorkOSService.verifyToken.mockResolvedValue({ id: 'workos-user-1', sessionId: 'session_abc', expiresAt: 9999999999 });
    mockWorkOSService.revokeSession.mockRejectedValue(new Error('WorkOS down'));

    const res = await request(app)
      .post('/api/v1/auth/logout')
      .set('Authorization', 'Bearer signed.jwt.token');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, revoked: false });
    expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error), { flow: 'auth-logout' });
  });
});

afterAll((done) => {
  if (httpServer) {
    httpServer.close(() => done());
  } else {
    done();
  }
});
