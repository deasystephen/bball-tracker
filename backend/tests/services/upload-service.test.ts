/**
 * Unit tests for upload-service
 *
 * Tests the S3 presigned URL generation and avatar deletion logic
 * with mocked AWS SDK clients.
 */

// Capture constructor args since jest.mock replaces classes
const putObjectCalls: any[] = [];
const deleteObjectCalls: any[] = [];

jest.mock('@aws-sdk/client-s3', () => {
  return {
    S3Client: jest.fn().mockImplementation(() => ({
      send: jest.fn().mockResolvedValue({}),
    })),
    PutObjectCommand: jest.fn().mockImplementation((input) => {
      putObjectCalls.push(input);
      return { input };
    }),
    DeleteObjectCommand: jest.fn().mockImplementation((input) => {
      deleteObjectCalls.push(input);
      return { input };
    }),
  };
});

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue(
    'https://bball-tracker-avatars-dev.s3.us-east-1.amazonaws.com/presigned?X-Amz-Signature=abc'
  ),
}));

import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { generateAvatarUploadUrl, deleteAvatar } from '../../src/services/upload-service';

const mockGetSignedUrl = getSignedUrl as jest.MockedFunction<typeof getSignedUrl>;

describe('Upload Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    putObjectCalls.length = 0;
    deleteObjectCalls.length = 0;
  });

  describe('generateAvatarUploadUrl', () => {
    const userId = 'a1b2c3d4-e5f6-7890-1234-567890abcdef';

    it('should generate presigned URL for image/jpeg', async () => {
      const result = await generateAvatarUploadUrl(userId, 'image/jpeg');

      expect(result.uploadUrl).toBeDefined();
      expect(result.imageUrl).toBeDefined();
      expect(result.imageUrl).toContain(userId);
      expect(result.imageUrl).toMatch(/\.jpg$/);
    });

    it('should generate presigned URL for image/png', async () => {
      const result = await generateAvatarUploadUrl(userId, 'image/png');

      expect(result.uploadUrl).toBeDefined();
      expect(result.imageUrl).toContain(userId);
      expect(result.imageUrl).toMatch(/\.png$/);
    });

    it('should use avatars/ prefix in the S3 key', async () => {
      const result = await generateAvatarUploadUrl(userId, 'image/jpeg');

      expect(result.imageUrl).toContain('avatars/');
    });

    it('should call getSignedUrl with 300s expiry', async () => {
      await generateAvatarUploadUrl(userId, 'image/jpeg');

      expect(mockGetSignedUrl).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ input: expect.any(Object) }),
        { expiresIn: 300 }
      );
    });

    it('should set correct ContentType in PutObjectCommand', async () => {
      await generateAvatarUploadUrl(userId, 'image/png');

      expect(putObjectCalls).toHaveLength(1);
      expect(putObjectCalls[0].ContentType).toBe('image/png');
    });

    it('should set correct bucket name in PutObjectCommand', async () => {
      await generateAvatarUploadUrl(userId, 'image/jpeg');

      expect(putObjectCalls[0].Bucket).toBe('bball-tracker-avatars-dev');
    });

    it('should include user ID in the S3 key path', async () => {
      await generateAvatarUploadUrl(userId, 'image/jpeg');

      expect(putObjectCalls[0].Key).toContain(`avatars/${userId}/`);
    });

    it('should generate unique keys for each call', async () => {
      await generateAvatarUploadUrl(userId, 'image/jpeg');
      await generateAvatarUploadUrl(userId, 'image/jpeg');

      expect(putObjectCalls).toHaveLength(2);
      expect(putObjectCalls[0].Key).not.toBe(putObjectCalls[1].Key);
    });

    it('should construct imageUrl with bucket domain', async () => {
      const result = await generateAvatarUploadUrl(userId, 'image/jpeg');

      expect(result.imageUrl).toMatch(
        /^https:\/\/bball-tracker-avatars-dev\.s3\.amazonaws\.com\/avatars\//
      );
    });

    it('should throw for unsupported content type', async () => {
      await expect(
        generateAvatarUploadUrl(userId, 'image/gif')
      ).rejects.toThrow('Unsupported content type: image/gif');
    });

    it('should throw for non-image content type', async () => {
      await expect(
        generateAvatarUploadUrl(userId, 'application/pdf')
      ).rejects.toThrow('Unsupported content type');
    });

    it('should propagate S3 errors', async () => {
      mockGetSignedUrl.mockRejectedValueOnce(new Error('S3 connection failed'));

      await expect(
        generateAvatarUploadUrl(userId, 'image/jpeg')
      ).rejects.toThrow('S3 connection failed');
    });
  });

  describe('deleteAvatar', () => {
    it('should create DeleteObjectCommand with correct key', async () => {
      await deleteAvatar(
        'https://bball-tracker-avatars-dev.s3.amazonaws.com/avatars/user-id/image.jpg'
      );

      expect(deleteObjectCalls).toHaveLength(1);
      expect(deleteObjectCalls[0].Key).toBe('avatars/user-id/image.jpg');
      expect(deleteObjectCalls[0].Bucket).toBe('bball-tracker-avatars-dev');
    });

    it('should strip leading slash from pathname', async () => {
      await deleteAvatar(
        'https://bball-tracker-avatars-dev.s3.amazonaws.com/avatars/user-id/photo.png'
      );

      expect(deleteObjectCalls[0].Key).toBe('avatars/user-id/photo.png');
      expect(deleteObjectCalls[0].Key).not.toMatch(/^\//);
    });

    it('should throw for invalid URL', async () => {
      await expect(deleteAvatar('not-a-url')).rejects.toThrow();
    });
  });
});
