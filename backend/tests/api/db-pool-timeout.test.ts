/**
 * #751: a pg pool-wait/connect timeout that reaches the central error handler
 * answers 503 with Retry-After, not a generic 500. Through the real router
 * chain and the real `authenticate` middleware, whose user lookup is the first
 * query on almost every request (and forwards its errors with `next`).
 */
import request from 'supertest';
import { app, httpServer } from '../../src/index';
import { WorkOSService } from '../../src/services/workos-service';
import { DB_BUSY_RETRY_AFTER_SECONDS } from '../../src/models/pool-config';
import { mockPrisma } from '../setup';
import { transactionClosed } from '../factories';

jest.mock('../../src/services/workos-service');

const mockWorkOS = WorkOSService as jest.Mocked<typeof WorkOSService>;

describe('database pool timeout through the central error handler', () => {
  afterAll((done) => {
    httpServer.close(() => done());
  });

  beforeEach(() => {
    mockWorkOS.verifyToken.mockResolvedValue({ id: 'workos_1', sessionId: 'sess_1', expiresAt: 0 });
  });

  it.each([
    'timeout exceeded when trying to connect',
    'Connection terminated due to connection timeout',
  ])('answers 503 with Retry-After for "%s"', async (message) => {
    (mockPrisma.user.findUnique as jest.Mock).mockRejectedValueOnce(new Error(message));

    const res = await request(app).get('/api/v1/teams').set('Authorization', 'Bearer signed.jwt.token');

    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe(String(DB_BUSY_RETRY_AFTER_SECONDS));
    expect(res.body).toEqual({ error: 'Service temporarily unavailable, please retry' });
  });

  it('answers a lock-wait transaction timeout (P2028) as 503 transaction_timeout (#908)', async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockRejectedValueOnce(transactionClosed());

    const res = await request(app).get('/api/v1/teams').set('Authorization', 'Bearer signed.jwt.token');

    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe(String(DB_BUSY_RETRY_AFTER_SECONDS));
    expect(res.body).toEqual({
      error: 'Another request for this record is still being processed; please retry',
      code: 'transaction_timeout',
    });
  });

  it('answers maxWait exhaustion (P2028) with the pool-busy body', async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockRejectedValueOnce(
      transactionClosed('Transaction API error: Unable to start a transaction in the given time.')
    );

    const res = await request(app).get('/api/v1/teams').set('Authorization', 'Bearer signed.jwt.token');

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'Service temporarily unavailable, please retry' });
  });

  it('still answers 500 for any other database error', async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    const res = await request(app).get('/api/v1/teams').set('Authorization', 'Bearer signed.jwt.token');

    expect(res.status).toBe(500);
    expect(res.headers['retry-after']).toBeUndefined();
  });
});
