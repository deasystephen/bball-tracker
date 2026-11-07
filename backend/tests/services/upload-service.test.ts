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
    DeleteObjectTaggingCommand: jest.fn().mockImplementation((input: unknown) => ({ kind: 'DeleteObjectTagging', input })),
    PutObjectTaggingCommand: jest.fn().mockImplementation((input: unknown) => ({ kind: 'PutObjectTagging', input })),
  };
});

jest.mock('@aws-sdk/s3-presigned-post', () => ({
  createPresignedPost: jest.fn().mockResolvedValue({
    url: 'https://bball-tracker-avatars-dev.s3.us-east-1.amazonaws.com/',
    fields: { key: 'avatars/x', Policy: 'policy', 'X-Amz-Signature': 'sig' },
  }),
}));

import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { logger } from '../../src/utils/logger';
import {
  assertAvatarStorageConfig,
  assertOwnUploadUrl,
  generateAvatarUploadUrl,
  deleteAvatar,
  deleteAvatarObject,
  deletePreviousAvatar,
  discardOwnAvatar,
  isManagedAvatarUrl,
  isOwnUploadUrl,
  MAX_AVATAR_BYTES,
  PENDING_TAGGING_XML,
  promoteAvatarUpload,
  revertAvatarToPending,
  withPromotedAvatar,
} from '../../src/services/upload-service';
import { UploadExpiredError } from '../../src/utils/errors';
import * as sentry from '../../src/utils/sentry';
import { BadRequestError } from '../../src/utils/errors';

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

    it('caps the object size, pins the content type and sends the pending tag as a field (#1005)', async () => {
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
          Fields: { 'Content-Type': 'image/png', tagging: PENDING_TAGGING_XML },
          Expires: 300,
        })
      );
    });

    it('the pending tag set is exactly pending=true', () => {
      expect(PENDING_TAGGING_XML).toBe(
        '<Tagging><TagSet><Tag><Key>pending</Key><Value>true</Value></Tag></TagSet></Tagging>'
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

  describe('deleteAvatarObject (#983)', () => {
    const a = 'a1b2c3d4-e5f6-4890-a234-567890abcdef';

    it('deletes an issued key in our bucket and says so', async () => {
      await expect(deleteAvatarObject(`${BUCKET_BASE}${a}/pic.jpg`)).resolves.toBe('deleted');
      expect(deleteObjectCalls).toEqual([{ Bucket: 'bball-tracker-avatars-dev', Key: `avatars/${a}/pic.jpg` }]);
    });

    it('reports a failed S3 delete instead of throwing', async () => {
      const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
      mockSend.mockRejectedValueOnce(new Error('boom'));
      await expect(deleteAvatarObject(`${BUCKET_BASE}${a}/pic.jpg`)).resolves.toBe('failed');
      expect(warnSpy).toHaveBeenCalledWith('Failed to delete avatar object', expect.objectContaining({ error: 'boom' }));
      warnSpy.mockRestore();
    });

    it('answers not_ours for an external URL, no URL, or a key outside the issued shape', async () => {
      const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
      await expect(deleteAvatarObject('https://workos.example/photo.jpg')).resolves.toBe('not_ours');
      await expect(deleteAvatarObject(null)).resolves.toBe('not_ours');
      await expect(deleteAvatarObject(`${BUCKET_BASE}${a}/extra/pic.jpg`)).resolves.toBe('not_ours');
      expect(deleteObjectCalls).toHaveLength(0);
      warnSpy.mockRestore();
    });
  });

  describe('assertAvatarStorageConfig (#983)', () => {
    it('throws when S3_AVATARS_BUCKET is unset', () => {
      expect(() => assertAvatarStorageConfig({})).toThrow(/S3_AVATARS_BUCKET/);
    });

    it('passes when it is set', () => {
      expect(() => assertAvatarStorageConfig({ S3_AVATARS_BUCKET: 'bucket' })).not.toThrow();
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

    describe('defence in depth behind the write-time gate (#717)', () => {
      const a = 'a1b2c3d4-e5f6-4890-a234-567890abcdef';
      let warnSpy: jest.SpyInstance;
      beforeEach(() => {
        warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
      });
      afterEach(() => warnSpy.mockRestore());

      it.each([
        ['a ../ hop out of avatars/ entirely', `${BUCKET_BASE}${a}/../../any-key.jpg`],
        ['an encoded hop out of avatars/', `${BUCKET_BASE}${a}/%2e%2e/%2e%2e/any-key.jpg`],
        ['a key with no user segment', `${BUCKET_BASE}../loose.jpg`],
        ['a key nested deeper than issued', `${BUCKET_BASE}${a}/extra/pic.jpg`],
      ])('sends no DeleteObjectCommand for %s and warns without the URL', async (_label, url) => {
        await deletePreviousAvatar(url, null);

        expect(deleteObjectCalls).toHaveLength(0);
        expect(mockSend).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringMatching(/not an issued upload key/),
          expect.not.objectContaining({ previousUrl: expect.anything() })
        );
        expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('any-key');
      });

      it('still deletes a key of the issued shape', async () => {
        await deletePreviousAvatar(`${BUCKET_BASE}${a}/pic.jpg`, null);
        expect(deleteObjectCalls).toEqual([{ Bucket: 'bball-tracker-avatars-dev', Key: `avatars/${a}/pic.jpg` }]);
      });
    });
  });

  describe('isOwnUploadUrl / assertOwnUploadUrl (#717)', () => {
    const callerId = 'a1b2c3d4-e5f6-4890-a234-567890abcdef';
    const otherId = 'ffffffff-0000-4000-8000-000000000001';

    it.each([
      ['an external https URL (WorkOS photo)', 'https://workos.example/photo.jpg'],
      ['an external URL that merely contains our prefix text', `https://evil.example/avatars/${otherId}/pic.jpg`],
      ['an object under the caller\'s own prefix', `${BUCKET_BASE}${callerId}/pic.jpg`],
    ])('allows %s', (_label, url) => {
      expect(isOwnUploadUrl(url, callerId)).toBe(true);
      expect(() => assertOwnUploadUrl(url, callerId)).not.toThrow();
    });

    it.each([
      ['another user\'s real avatar URL', `${BUCKET_BASE}${otherId}/pic.jpg`],
      ['a ../ hop from the own prefix into another', `${BUCKET_BASE}${callerId}/../${otherId}/pic.jpg`],
      ['an encoded ../ hop', `${BUCKET_BASE}${callerId}/%2e%2e/${otherId}/pic.jpg`],
      ['a ../ hop out of avatars/', `${BUCKET_BASE}${callerId}/../../any-key.jpg`],
      ['a prefix-sharing id', `${BUCKET_BASE}${callerId}-x/pic.jpg`],
      ['a key nested deeper than issued', `${BUCKET_BASE}${callerId}/deeper/pic.jpg`],
      ['the bare prefix with no file', `${BUCKET_BASE}${callerId}/`],
    ])('rejects %s', (_label, url) => {
      expect(isOwnUploadUrl(url, callerId)).toBe(false);
      expect(() => assertOwnUploadUrl(url, callerId)).toThrow(BadRequestError);
      expect(() => assertOwnUploadUrl(url, callerId)).toThrow('profilePictureUrl must be an upload issued to the caller');
    });

    it('treats null and undefined as nothing to check', () => {
      expect(isOwnUploadUrl(null, callerId)).toBe(true);
      expect(isOwnUploadUrl(undefined, callerId)).toBe(true);
    });
  });

  describe('discardOwnAvatar (#419)', () => {
    const callerId = 'a1b2c3d4-e5f6-4890-a234-567890abcdef';
    const otherId = 'ffffffff-0000-4000-8000-000000000001';

    it('deletes an object under the caller\'s own avatars/<userId>/ prefix', async () => {
      await discardOwnAvatar(`${BUCKET_BASE}${callerId}/pic.jpg`, callerId);

      expect(deleteObjectCalls).toEqual([
        { Bucket: 'bball-tracker-avatars-dev', Key: `avatars/${callerId}/pic.jpg` },
      ]);
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('never deletes an object under another user\'s prefix (client-supplied URL)', async () => {
      await discardOwnAvatar(`${BUCKET_BASE}${otherId}/pic.jpg`, callerId);

      expect(deleteObjectCalls).toHaveLength(0);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('does not let a prefix-sharing id match (avatars/<id>-suffix/)', async () => {
      await discardOwnAvatar(`${BUCKET_BASE}${callerId}-x/pic.jpg`, callerId);
      expect(deleteObjectCalls).toHaveLength(0);
    });

    it('checks ownership on the normalised path, so a ../ hop out of the own prefix deletes nothing', async () => {
      // URL parsing collapses `..` (and `%2e%2e`) before the key is derived
      await discardOwnAvatar(`${BUCKET_BASE}${callerId}/../${otherId}/pic.jpg`, callerId);
      await discardOwnAvatar(`${BUCKET_BASE}${callerId}/%2e%2e/${otherId}/pic.jpg`, callerId);

      expect(deleteObjectCalls).toHaveLength(0);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('never touches objects outside our bucket', async () => {
      await discardOwnAvatar('https://workos.example/photo.jpg', callerId);
      await discardOwnAvatar(`https://evil.example/avatars/${callerId}/pic.jpg`, callerId);

      expect(deleteObjectCalls).toHaveLength(0);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('is a no-op without a URL', async () => {
      await discardOwnAvatar(undefined, callerId);
      await discardOwnAvatar(null, callerId);
      expect(deleteObjectCalls).toHaveLength(0);
    });

    it('logs a warning and never throws when S3 rejects (the invitation already exists)', async () => {
      const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
      mockSend.mockRejectedValueOnce(new Error('AccessDenied'));

      await expect(discardOwnAvatar(`${BUCKET_BASE}${callerId}/pic.jpg`, callerId)).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/discard/i),
        expect.objectContaining({ error: 'AccessDenied' })
      );
      warnSpy.mockRestore();
    });
  });

  describe('promoteAvatarUpload (#1005)', () => {
    const OWN = `${BUCKET_BASE}u1/pic.jpg`;
    const sdkError = (name: string, status: number): Error =>
      Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
    let errorSpy: jest.SpyInstance;
    let captureSpy: jest.SpyInstance;

    beforeEach(() => {
      mockSend.mockReset();
      mockSend.mockResolvedValue({});
      errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
      captureSpy = jest.spyOn(sentry, 'captureException').mockImplementation(() => undefined);
    });

    afterEach(() => {
      errorSpy.mockRestore();
      captureSpy.mockRestore();
    });

    it('removes the tags of an upload in our bucket and says it promoted', async () => {
      await expect(promoteAvatarUpload(OWN)).resolves.toBe(true);
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend.mock.calls[0][0]).toEqual({
        kind: 'DeleteObjectTagging',
        input: { Bucket: 'bball-tracker-avatars-dev', Key: 'avatars/u1/pic.jpg' },
      });
    });

    it('skips external URLs and empty values', async () => {
      await expect(promoteAvatarUpload('https://workos.example/photo.jpg')).resolves.toBe(false);
      await expect(promoteAvatarUpload(undefined)).resolves.toBe(false);
      await expect(promoteAvatarUpload(null)).resolves.toBe(false);
      await expect(promoteAvatarUpload('')).resolves.toBe(false);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('refuses a managed URL outside the issued key shape without calling S3', async () => {
      await expect(promoteAvatarUpload(`${BUCKET_BASE}u1/x/../../../other.jpg`)).rejects.toBeInstanceOf(
        BadRequestError
      );
      await expect(promoteAvatarUpload(`${BUCKET_BASE}u1/nested/pic.jpg`)).rejects.toBeInstanceOf(BadRequestError);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('answers 400 upload_expired when the object is gone (NoSuchKey by name)', async () => {
      mockSend.mockRejectedValueOnce(sdkError('NoSuchKey', 404));
      const err = await promoteAvatarUpload(OWN).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UploadExpiredError);
      expect((err as UploadExpiredError).statusCode).toBe(400);
      expect((err as UploadExpiredError).body()).toEqual({
        error: 'That photo upload expired. Please choose it again.',
        code: 'upload_expired',
      });
      expect(captureSpy).not.toHaveBeenCalled();
    });

    it('also recognises NoSuchKey given as `Code`', async () => {
      mockSend.mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'S3ServiceException', Code: 'NoSuchKey' }));
      await expect(promoteAvatarUpload(OWN)).rejects.toBeInstanceOf(UploadExpiredError);
    });

    it.each([
      ['AccessDenied', 403],
      ['NoSuchBucket', 404],
      ['NotFound', 404],
    ])('treats %s (%i) as a fault: logged at error, captured, rethrown, never upload_expired', async (name, status) => {
      const fault = sdkError(name, status);
      mockSend.mockRejectedValueOnce(fault);

      await expect(promoteAvatarUpload(OWN)).rejects.toBe(fault);

      expect(errorSpy).toHaveBeenCalledWith(
        'Avatar promotion failed',
        expect.objectContaining({ operation: 'DeleteObjectTagging', code: name, key: 'avatars/u1/pic.jpg' })
      );
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('https://');
      expect(captureSpy).toHaveBeenCalledWith(fault, { flow: 'avatar-promote' });
    });

    it('rethrows a non-Error rejection as is', async () => {
      mockSend.mockRejectedValueOnce('socket hang up');
      await expect(promoteAvatarUpload(OWN)).rejects.toBe('socket hang up');
      expect(errorSpy).toHaveBeenCalledWith(
        'Avatar promotion failed',
        expect.objectContaining({ code: undefined, error: 'socket hang up' })
      );
    });
  });

  describe('revertAvatarToPending (#1005)', () => {
    const OWN = `${BUCKET_BASE}u1/pic.jpg`;
    let errorSpy: jest.SpyInstance;
    let captureSpy: jest.SpyInstance;

    beforeEach(() => {
      mockSend.mockReset();
      mockSend.mockResolvedValue({});
      deleteObjectCalls.length = 0;
      errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
      captureSpy = jest.spyOn(sentry, 'captureException').mockImplementation(() => undefined);
    });

    afterEach(() => {
      errorSpy.mockRestore();
      captureSpy.mockRestore();
    });

    it('puts the pending=true tag back on the object', async () => {
      await revertAvatarToPending(OWN);
      expect(mockSend.mock.calls[0][0]).toEqual({
        kind: 'PutObjectTagging',
        input: {
          Bucket: 'bball-tracker-avatars-dev',
          Key: 'avatars/u1/pic.jpg',
          Tagging: { TagSet: [{ Key: 'pending', Value: 'true' }] },
        },
      });
      expect(deleteObjectCalls).toHaveLength(0);
    });

    it('does nothing for an external, empty or misshaped URL', async () => {
      await revertAvatarToPending('https://workos.example/p.jpg');
      await revertAvatarToPending(null);
      await revertAvatarToPending(`${BUCKET_BASE}u1/nested/pic.jpg`);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('never throws and never deletes: logs the key (never the URL) at error and captures', async () => {
      const fault = Object.assign(new Error('denied'), { name: 'AccessDenied' });
      mockSend.mockRejectedValueOnce(fault);

      await expect(revertAvatarToPending(OWN)).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledWith('Could not revert avatar upload to pending', {
        operation: 'PutObjectTagging',
        key: 'avatars/u1/pic.jpg',
        code: 'AccessDenied',
        error: 'denied',
      });
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('https://');
      expect(captureSpy).toHaveBeenCalledWith(fault, { flow: 'avatar-revert' });
      expect(deleteObjectCalls).toHaveLength(0);
    });

    it('stringifies a non-Error failure', async () => {
      mockSend.mockRejectedValueOnce('boom');
      await revertAvatarToPending(OWN);
      expect(errorSpy).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ error: 'boom' }));
    });
  });

  describe('withPromotedAvatar (#1005)', () => {
    const OWN = `${BUCKET_BASE}u1/pic.jpg`;
    const kinds = (): string[] => mockSend.mock.calls.map(([cmd]) => (cmd as { kind: string }).kind);

    beforeEach(() => {
      mockSend.mockReset();
      mockSend.mockResolvedValue({});
      deleteObjectCalls.length = 0;
    });

    it('promotes, then writes, and returns the write result', async () => {
      const write = jest.fn().mockResolvedValue('row');
      await expect(withPromotedAvatar(OWN, write)).resolves.toBe('row');
      expect(mockSend.mock.invocationCallOrder[0]).toBeLessThan(write.mock.invocationCallOrder[0]);
      expect(kinds()).toEqual(['DeleteObjectTagging']);
    });

    it('reverts the upload to pending when the write fails, rethrows, and deletes nothing', async () => {
      const failure = new Error('P2002');
      await expect(withPromotedAvatar(OWN, () => Promise.reject(failure))).rejects.toBe(failure);
      expect(kinds()).toEqual(['DeleteObjectTagging', 'PutObjectTagging']);
      expect(deleteObjectCalls).toHaveLength(0);
    });

    it('does not write when promotion fails, and has nothing to revert for an external URL', async () => {
      mockSend.mockRejectedValueOnce(Object.assign(new Error('gone'), { name: 'NoSuchKey' }));
      const write = jest.fn();
      await expect(withPromotedAvatar(OWN, write)).rejects.toBeInstanceOf(UploadExpiredError);
      expect(write).not.toHaveBeenCalled();

      mockSend.mockClear();
      await expect(
        withPromotedAvatar('https://workos.example/p.jpg', () => Promise.reject(new Error('x')))
      ).rejects.toThrow('x');
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});
