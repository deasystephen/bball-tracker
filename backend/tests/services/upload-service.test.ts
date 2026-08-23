/**
 * Unit tests for upload-service
 *
 * Covers the presigned POST policy (size cap + content-type pin), avatar
 * deletion and best-effort cleanup of a replaced avatar, with mocked AWS SDK
 * clients.
 */

import type { DeleteObjectCommandInput } from '@aws-sdk/client-s3';

const deleteObjectCalls: DeleteObjectCommandInput[] = [];
const mockSend = jest.fn().mockResolvedValue({});

jest.mock('@aws-sdk/client-s3', () => {
  return {
    S3Client: jest.fn().mockImplementation(() => ({ send: mockSend })),
    DeleteObjectCommand: jest.fn().mockImplementation((input: DeleteObjectCommandInput) => {
      deleteObjectCalls.push(input);
      return { input };
    }),
  };
});

jest.mock('@aws-sdk/s3-presigned-post', () => ({
  createPresignedPost: jest.fn().mockResolvedValue({
    url: 'https://bball-tracker-avatars-dev.s3.us-east-1.amazonaws.com/',
    fields: { key: 'avatars/x', Policy: 'policy', 'X-Amz-Signature': 'sig' },
  }),
}));

import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import {
  generateAvatarUploadUrl,
  deleteAvatar,
  deletePreviousAvatar,
  isManagedAvatarUrl,
  MAX_AVATAR_BYTES,
} from '../../src/services/upload-service';

const mockCreatePresignedPost = createPresignedPost as jest.MockedFunction<typeof createPresignedPost>;

const BUCKET_BASE = 'https://bball-tracker-avatars-dev.s3.amazonaws.com/avatars/';

describe('Upload Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSend.mockResolvedValue({});
    deleteObjectCalls.length = 0;
  });

  describe('generateAvatarUploadUrl', () => {
    const userId = 'a1b2c3d4-e5f6-4890-a234-567890abcdef';

    it('returns the POST url, policy fields and public image URL for image/jpeg', async () => {
      const result = await generateAvatarUploadUrl(userId, 'image/jpeg');

      expect(result.uploadUrl).toBe('https://bball-tracker-avatars-dev.s3.us-east-1.amazonaws.com/');
      expect(result.fields).toEqual(expect.objectContaining({ Policy: 'policy' }));
      expect(result.imageUrl).toContain(`avatars/${userId}/`);
      expect(result.imageUrl).toMatch(/\.jpg$/);
    });

    it('uses a .png key for image/png', async () => {
      const result = await generateAvatarUploadUrl(userId, 'image/png');
      expect(result.imageUrl).toMatch(/\.png$/);
    });

    it('caps the object size and pins the content type in the policy', async () => {
      await generateAvatarUploadUrl(userId, 'image/png');

      expect(mockCreatePresignedPost).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          Bucket: 'bball-tracker-avatars-dev',
          Key: expect.stringMatching(new RegExp(`^avatars/${userId}/[0-9a-f-]+\\.png$`)),
          Conditions: [
            ['content-length-range', 1, MAX_AVATAR_BYTES],
            ['eq', '$Content-Type', 'image/png'],
          ],
          Fields: { 'Content-Type': 'image/png' },
          Expires: 300,
        })
      );
    });

    it('MAX_AVATAR_BYTES is 5 MB', () => {
      expect(MAX_AVATAR_BYTES).toBe(5 * 1024 * 1024);
    });

    it('accepts a declared contentLength within the cap', async () => {
      await expect(generateAvatarUploadUrl(userId, 'image/jpeg', MAX_AVATAR_BYTES)).resolves.toBeDefined();
    });

    it('rejects a declared contentLength over the cap without signing', async () => {
      await expect(generateAvatarUploadUrl(userId, 'image/jpeg', MAX_AVATAR_BYTES + 1)).rejects.toThrow(
        /Avatar must be between/
      );
      expect(mockCreatePresignedPost).not.toHaveBeenCalled();
    });

    it('rejects a zero contentLength', async () => {
      await expect(generateAvatarUploadUrl(userId, 'image/jpeg', 0)).rejects.toThrow();
    });

    it('throws for unsupported content types', async () => {
      await expect(generateAvatarUploadUrl(userId, 'image/gif')).rejects.toThrow('Unsupported content type: image/gif');
      expect(mockCreatePresignedPost).not.toHaveBeenCalled();
    });

    it('generates a unique key per call', async () => {
      const a = await generateAvatarUploadUrl(userId, 'image/jpeg');
      const b = await generateAvatarUploadUrl(userId, 'image/jpeg');
      expect(a.imageUrl).not.toBe(b.imageUrl);
    });
  });

  describe('deleteAvatar', () => {
    it('deletes the object addressed by the image URL', async () => {
      await deleteAvatar(`${BUCKET_BASE}user-1/pic.jpg`);

      expect(deleteObjectCalls).toHaveLength(1);
      expect(deleteObjectCalls[0]).toEqual({
        Bucket: 'bball-tracker-avatars-dev',
        Key: 'avatars/user-1/pic.jpg',
      });
      expect(mockSend).toHaveBeenCalled();
    });

    it('propagates S3 errors', async () => {
      mockSend.mockRejectedValueOnce(new Error('AccessDenied'));
      await expect(deleteAvatar(`${BUCKET_BASE}user-1/pic.jpg`)).rejects.toThrow('AccessDenied');
    });

    it('throws on an invalid URL', async () => {
      await expect(deleteAvatar('not a url')).rejects.toThrow();
    });
  });

  describe('isManagedAvatarUrl', () => {
    it('is true only for objects under avatars/ in our bucket', () => {
      expect(isManagedAvatarUrl(`${BUCKET_BASE}u/a.jpg`)).toBe(true);
      expect(isManagedAvatarUrl('https://workos.example/photo.jpg')).toBe(false);
      expect(isManagedAvatarUrl(null)).toBe(false);
      expect(isManagedAvatarUrl(undefined)).toBe(false);
    });
  });

  describe('deletePreviousAvatar', () => {
    it('deletes the previous object when a new avatar replaces it', async () => {
      await deletePreviousAvatar(`${BUCKET_BASE}u/old.jpg`, `${BUCKET_BASE}u/new.jpg`);
      expect(deleteObjectCalls).toEqual([{ Bucket: 'bball-tracker-avatars-dev', Key: 'avatars/u/old.jpg' }]);
    });

    it('deletes the previous object when the avatar is cleared', async () => {
      await deletePreviousAvatar(`${BUCKET_BASE}u/old.jpg`, null);
      expect(deleteObjectCalls).toHaveLength(1);
    });

    it('is a no-op when the URL did not change', async () => {
      await deletePreviousAvatar(`${BUCKET_BASE}u/same.jpg`, `${BUCKET_BASE}u/same.jpg`);
      expect(deleteObjectCalls).toHaveLength(0);
    });

    it('never touches objects outside our bucket (e.g. WorkOS profile photos)', async () => {
      await deletePreviousAvatar('https://workos.example/photo.jpg', `${BUCKET_BASE}u/new.jpg`);
      expect(deleteObjectCalls).toHaveLength(0);
    });

    it('is a no-op when there was no previous avatar', async () => {
      await deletePreviousAvatar(null, `${BUCKET_BASE}u/new.jpg`);
      expect(deleteObjectCalls).toHaveLength(0);
    });

    it('swallows S3 errors (the profile update already succeeded)', async () => {
      mockSend.mockRejectedValueOnce(new Error('boom'));
      await expect(deletePreviousAvatar(`${BUCKET_BASE}u/old.jpg`, null)).resolves.toBeUndefined();
    });
  });
});
