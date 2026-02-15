/**
 * Uploads API Integration Tests
 */

import request from 'supertest';
import { app, httpServer } from '../../src/index';
import { authenticate } from '../../src/api/auth/middleware';
import { generateAvatarUploadUrl } from '../../src/services/upload-service';

// Test UUIDs
const TEST_USER_ID = 'a1b2c3d4-e5f6-7890-1234-567890abcdef';

// Mock the authenticate middleware
jest.mock('../../src/api/auth/middleware', () => ({
  authenticate: jest.fn((req, _res, next) => {
    req.user = {
      id: 'a1b2c3d4-e5f6-7890-1234-567890abcdef',
      email: 'test@example.com',
      name: 'Test User',
      role: 'COACH',
    };
    next();
  }),
  requireRole: jest.fn(() => (_req: any, _res: any, next: any) => next()),
}));

// Mock the upload service
jest.mock('../../src/services/upload-service');

const mockGenerateAvatarUploadUrl = generateAvatarUploadUrl as jest.MockedFunction<
  typeof generateAvatarUploadUrl
>;

describe('Uploads API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/v1/uploads/avatar-url', () => {
    const mockUploadResult = {
      uploadUrl: 'https://bball-tracker-avatars-dev.s3.us-east-1.amazonaws.com/avatars/a1b2c3d4-e5f6-7890-1234-567890abcdef/test-uuid.jpg?X-Amz-Signature=abc123',
      imageUrl: 'https://bball-tracker-avatars-dev.s3.amazonaws.com/avatars/a1b2c3d4-e5f6-7890-1234-567890abcdef/test-uuid.jpg',
    };

    it('should generate upload URL for image/jpeg', async () => {
      mockGenerateAvatarUploadUrl.mockResolvedValue(mockUploadResult);

      const response = await request(app)
        .post('/api/v1/uploads/avatar-url')
        .send({ contentType: 'image/jpeg' });

      expect(response.status).toBe(200);
      expect(response.body.uploadUrl).toBeDefined();
      expect(response.body.imageUrl).toBeDefined();
      expect(mockGenerateAvatarUploadUrl).toHaveBeenCalledWith(
        TEST_USER_ID,
        'image/jpeg'
      );
    });

    it('should generate upload URL for image/png', async () => {
      const pngResult = {
        ...mockUploadResult,
        uploadUrl: mockUploadResult.uploadUrl.replace('.jpg', '.png'),
        imageUrl: mockUploadResult.imageUrl.replace('.jpg', '.png'),
      };
      mockGenerateAvatarUploadUrl.mockResolvedValue(pngResult);

      const response = await request(app)
        .post('/api/v1/uploads/avatar-url')
        .send({ contentType: 'image/png' });

      expect(response.status).toBe(200);
      expect(response.body.uploadUrl).toBeDefined();
      expect(response.body.imageUrl).toBeDefined();
      expect(mockGenerateAvatarUploadUrl).toHaveBeenCalledWith(
        TEST_USER_ID,
        'image/png'
      );
    });

    it('should return uploadUrl that is a valid URL', async () => {
      mockGenerateAvatarUploadUrl.mockResolvedValue(mockUploadResult);

      const response = await request(app)
        .post('/api/v1/uploads/avatar-url')
        .send({ contentType: 'image/jpeg' });

      expect(response.status).toBe(200);
      expect(() => new URL(response.body.uploadUrl)).not.toThrow();
    });

    it('should return imageUrl containing the user ID', async () => {
      mockGenerateAvatarUploadUrl.mockResolvedValue(mockUploadResult);

      const response = await request(app)
        .post('/api/v1/uploads/avatar-url')
        .send({ contentType: 'image/jpeg' });

      expect(response.status).toBe(200);
      expect(response.body.imageUrl).toContain(TEST_USER_ID);
    });

    it('should return 400 for invalid content type', async () => {
      const response = await request(app)
        .post('/api/v1/uploads/avatar-url')
        .send({ contentType: 'image/gif' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    it('should return 400 for missing content type', async () => {
      const response = await request(app)
        .post('/api/v1/uploads/avatar-url')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    it('should return 400 for non-image content type', async () => {
      const response = await request(app)
        .post('/api/v1/uploads/avatar-url')
        .send({ contentType: 'application/pdf' });

      expect(response.status).toBe(400);
    });

    it('should handle service errors gracefully', async () => {
      mockGenerateAvatarUploadUrl.mockRejectedValue(new Error('S3 error'));

      const response = await request(app)
        .post('/api/v1/uploads/avatar-url')
        .send({ contentType: 'image/jpeg' });

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Failed to generate upload URL');
    });
  });

  describe('Authentication', () => {
    it('should require authentication', async () => {
      // Override the mock to simulate no auth
      (authenticate as jest.Mock).mockImplementationOnce((_req: any, res: any) => {
        res.status(401).json({ error: 'Authorization token required' });
      });

      const response = await request(app)
        .post('/api/v1/uploads/avatar-url')
        .send({ contentType: 'image/jpeg' });

      expect(response.status).toBe(401);
    });
  });
});

afterAll((done) => {
  if (httpServer) {
    httpServer.close(() => done());
  } else {
    done();
  }
});
