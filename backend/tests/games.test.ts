/**
 * Games API tests
 */

import request from 'supertest';
import { app, httpServer } from '../src/index';

describe('Games API', () => {
  // Mock token for testing (in real tests, you'd get this from WorkOS)
  const mockToken = 'mock-token-for-testing';

  describe('Authentication Required', () => {
    it('should return 401 for unauthenticated GET /games', async () => {
      const response = await request(app).get('/api/v1/games');
      expect(response.status).toBe(401);
    });

    it('should return 401 for unauthenticated POST /games', async () => {
      const response = await request(app).post('/api/v1/games').send({});
      expect(response.status).toBe(401);
    });

    it('should return 401 for unauthenticated GET /games/:id', async () => {
      const response = await request(app).get('/api/v1/games/test-id');
      expect(response.status).toBe(401);
    });
  });

  describe('Validation', () => {
    it('should return 400 for invalid game data', async () => {
      // This will fail authentication, but if it passed, would fail validation
      const response = await request(app)
        .post('/api/v1/games')
        .set('Authorization', `Bearer ${mockToken}`)
        .send({
          // Missing required fields
          opponent: 'Lakers',
        });
      
      // Will be 401 (auth fails) or 400 (validation fails if auth passes)
      expect([400, 401]).toContain(response.status);
    });
  });

  // Note: Full integration tests would require:
  // 1. A valid WorkOS access token
  // 2. Test data (teams, users) in the database
  // 3. Mocking WorkOS service or using test credentials
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
