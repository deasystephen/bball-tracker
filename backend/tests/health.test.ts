import request from 'supertest';
import { app, httpServer } from '../src/index';
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

