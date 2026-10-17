// Spy on Sentry capture while keeping the rest of the util real.
jest.mock('../src/utils/sentry', () => ({
  ...jest.requireActual('../src/utils/sentry'),
  captureException: jest.fn(),
}));

import request from 'supertest';
import { app, httpServer } from '../src/index';
import { captureException } from '../src/utils/sentry';
import { mockPrisma } from './setup';

describe('Health Check', () => {
  it('should return 200 and status ok when the DB ping succeeds', async () => {
    (mockPrisma.$queryRaw as jest.Mock).mockResolvedValueOnce([{ '?column?': 1 }]);

    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.db).toBe('ok');
    expect(response.body.timestamp).toBeDefined();
    expect(mockPrisma.$queryRaw).toHaveBeenCalled();
  });

  it('should return 503 degraded when the DB is unreachable', async () => {
    (mockPrisma.$queryRaw as jest.Mock).mockRejectedValueOnce(
      new Error('no pg_hba.conf entry ... no encryption')
    );

    const response = await request(app).get('/health');
    expect(response.status).toBe(503);
    expect(response.body.status).toBe('degraded');
    expect(response.body.db).toBe('down');
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), { flow: 'health-check', db: 'down' });
  });

  // #751: pg's connectionTimeoutMillis fired; the pool is saturated or RDS is
  // not answering TCP. Still 503, but the body names the cause.
  it.each([
    'timeout exceeded when trying to connect',
    'Connection terminated due to connection timeout',
  ])('returns 503 with db "timeout" when the ping fails with "%s"', async (message) => {
    (mockPrisma.$queryRaw as jest.Mock).mockRejectedValueOnce(new Error(message));

    const response = await request(app).get('/health');
    expect(response.status).toBe(503);
    expect(response.body.status).toBe('degraded');
    expect(response.body.db).toBe('timeout');
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), { flow: 'health-check', db: 'timeout' });
  });

  // #570: "what is in production" is one request, with no AWS access.
  describe('commit', () => {
    const COMMIT = 'e87ed33577de095449591fc2ca47640fea8520ce';
    const previous = process.env.SENTRY_RELEASE;

    afterEach(() => {
      if (previous === undefined) delete process.env.SENTRY_RELEASE;
      else process.env.SENTRY_RELEASE = previous;
    });

    it('returns the commit the running image was built from', async () => {
      process.env.SENTRY_RELEASE = COMMIT;
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValueOnce([{ '?column?': 1 }]);

      const response = await request(app).get('/health');
      expect(response.status).toBe(200);
      expect(response.body.commit).toBe(COMMIT);
    });

    it('returns it on a degraded answer too, which is when it is needed most', async () => {
      process.env.SENTRY_RELEASE = COMMIT;
      (mockPrisma.$queryRaw as jest.Mock).mockRejectedValueOnce(new Error('connection refused'));

      const response = await request(app).get('/health');
      expect(response.status).toBe(503);
      expect(response.body.commit).toBe(COMMIT);
    });

    it('is null, and still present, when the process was not built by the deploy job', async () => {
      delete process.env.SENTRY_RELEASE;
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValueOnce([{ '?column?': 1 }]);

      const response = await request(app).get('/health');
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('commit', null);
    });
  });
});

describe('API Root', () => {
  it('should return API info', async () => {
    const response = await request(app).get('/api/v1');
    expect(response.status).toBe(200);
    expect(response.body.message).toBe('API v1');
  });
});

describe('404 Handler', () => {
  it('should return 404 for unknown routes', async () => {
    const response = await request(app).get('/unknown-route');
    expect(response.status).toBe(404);
    expect(response.body.error).toBe('Not found');
  });
});

// Close server after all tests
afterAll((done) => {
  if (httpServer) {
    httpServer.close(() => {
      done();
    });
  } else {
    done();
  }
});


// #749: the ALB (idle timeout 60 s, `aws_lb.main` in infra/ecs.tf) reuses
// keep-alive connections; Node must hold them open longer or the ALB answers
// 502 on a connection the task is closing.
describe('HTTP server keep-alive vs the ALB idle timeout', () => {
  const ALB_IDLE_TIMEOUT_MS = 60_000;

  it('keeps idle connections open longer than the ALB does', () => {
    expect(httpServer.keepAliveTimeout).toBeGreaterThan(ALB_IDLE_TIMEOUT_MS);
    expect(httpServer.headersTimeout).toBeGreaterThan(httpServer.keepAliveTimeout);
  });
});
