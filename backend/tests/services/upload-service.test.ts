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
    DeleteObjectsCommand: jest.fn().mockImplementation((input: unknown) => ({ kind: 'DeleteObjects', input })),
    ListObjectsV2Command: jest.fn().mockImplementation((input: unknown) => ({ kind: 'ListObjectsV2', input })),
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
  assertOwnUploadUrl,
  generateAvatarUploadUrl,
  deleteAvatar,
  deleteAvatarKeys,
  deletePreviousAvatar,
  deleteUnreferencedUserUploads,
  isDeletableAge,
  isIssuedAvatarKey,
  listAvatarObjectPages,
  scheduleUserUploadCleanup,
  settleUploadCleanups,
  ACCOUNT_UPLOAD_MIN_AGE_MS,
  loadReferencedAvatarKeys,
  referencedAvatarKeys,
  discardOwnAvatar,
  isManagedAvatarUrl,
  isOwnUploadUrl,
  MAX_AVATAR_BYTES,
} from '../../src/services/upload-service';
import { BadRequestError } from '../../src/utils/errors';
import { mockPrisma } from '../setup';

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

  // -------------------------------------------------------------------------
  // Unreferenced uploads (#957)
  // -------------------------------------------------------------------------

  describe('unreferenced uploads (#957)', () => {
    beforeEach(() => {
      // `clearAllMocks` keeps queued `…Once` values; start each case clean.
      mockSend.mockReset();
      mockSend.mockResolvedValue({});
      (mockPrisma.user.findMany as jest.Mock).mockReset();
      (mockPrisma.user.findMany as jest.Mock).mockResolvedValue([]);
    });

    type Sent = { kind: string; input: Record<string, unknown> };
    const sentOf = (kind: string): Sent[] =>
      mockSend.mock.calls.map(([cmd]) => cmd as Sent).filter((cmd) => cmd.kind === kind);

    /** Collects every page `listAvatarObjectPages` yields. */
    async function collect(
      prefix: string,
      options?: Parameters<typeof listAvatarObjectPages>[1]
    ): Promise<{ key: string; lastModified: Date | undefined }[]> {
      const objects: { key: string; lastModified: Date | undefined }[] = [];
      for await (const page of listAvatarObjectPages(prefix, options)) {
        objects.push(...page);
      }
      return objects;
    }

    describe('listAvatarObjectPages (paging)', () => {
      it('pages through ListObjectsV2 until the listing is not truncated', async () => {
        const t = new Date('2026-01-01T00:00:00Z');
        mockSend
          .mockResolvedValueOnce({
            Contents: [{ Key: 'avatars/u/a.jpg', LastModified: t }, { LastModified: t }],
            IsTruncated: true,
            NextContinuationToken: 'next',
          })
          .mockResolvedValueOnce({
            Contents: [{ Key: 'avatars/u/b.jpg', LastModified: t }],
            IsTruncated: false,
          });

        const objects = await collect('avatars/');

        expect(objects).toEqual([
          { key: 'avatars/u/a.jpg', lastModified: t },
          { key: 'avatars/u/b.jpg', lastModified: t },
        ]);
        const lists = sentOf('ListObjectsV2');
        expect(lists).toHaveLength(2);
        expect(lists[0].input).toEqual(
          expect.objectContaining({
            Prefix: 'avatars/',
            ContinuationToken: undefined,
          })
        );
        expect(lists[1].input).toEqual(expect.objectContaining({ ContinuationToken: 'next' }));
      });

      it('stops after maxPages and passes the abort signal to every call', async () => {
        const controller = new AbortController();
        mockSend.mockResolvedValue({
          Contents: [{ Key: 'avatars/u/a.jpg' }],
          IsTruncated: true,
          NextContinuationToken: 'more',
        });

        const objects = await collect('avatars/u/', { signal: controller.signal, maxPages: 1 });

        expect(objects).toEqual([{ key: 'avatars/u/a.jpg', lastModified: undefined }]);
        expect(mockSend).toHaveBeenCalledTimes(1);
        expect(mockSend.mock.calls[0][1]).toEqual({ abortSignal: controller.signal });
      });

      it('throws rather than returning a partial listing when a page fails', async () => {
        mockSend
          .mockResolvedValueOnce({
            Contents: [{ Key: 'avatars/u/a.jpg' }],
            IsTruncated: true,
            NextContinuationToken: 'n',
          })
          .mockRejectedValueOnce(new Error('AccessDenied'));
        await expect(collect('avatars/')).rejects.toThrow('AccessDenied');
      });

      it('throws when aborted before a page', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(collect('avatars/', { signal: controller.signal })).rejects.toThrow(/aborted/);
        expect(mockSend).not.toHaveBeenCalled();
      });
    });

    describe('listAvatarObjectPages', () => {
      it('yields one page at a time', async () => {
        mockSend
          .mockResolvedValueOnce({ Contents: [{ Key: 'avatars/u/a.jpg' }], IsTruncated: true, NextContinuationToken: 'n' })
          .mockResolvedValueOnce({ Contents: [{ Key: 'avatars/u/b.jpg' }] });
        const pages: string[][] = [];
        for await (const page of listAvatarObjectPages('avatars/')) {
          pages.push(page.map((o) => o.key));
        }
        expect(pages).toEqual([['avatars/u/a.jpg'], ['avatars/u/b.jpg']]);
      });
    });

    describe('isDeletableAge', () => {
      it('needs an issued key and a LastModified at or before the cutoff', () => {
        const t = new Date('2026-01-01T00:00:00Z');
        expect(isDeletableAge({ key: 'avatars/u/a.jpg', lastModified: t }, t.getTime())).toBe(true);
        expect(isDeletableAge({ key: 'avatars/u/a.jpg', lastModified: t }, t.getTime() - 1)).toBe(false);
        expect(isDeletableAge({ key: 'avatars/u/a.jpg', lastModified: undefined }, t.getTime())).toBe(false);
        expect(isDeletableAge({ key: 'avatars/a.jpg', lastModified: t }, t.getTime())).toBe(false);
      });
    });

    describe('scheduleUserUploadCleanup', () => {
      const userId = 'a1b2c3d4-e5f6-4890-a234-567890abcdef';

      it('starts the cleanup without waiting for it; settleUploadCleanups waits', async () => {
        let releaseList: (v: unknown) => void = () => undefined;
        mockSend.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              releaseList = resolve;
            })
        );

        scheduleUserUploadCleanup(userId); // returns at once
        expect(sentOf('ListObjectsV2')).toHaveLength(1);

        let settled = false;
        const settling = settleUploadCleanups().then(() => {
          settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);
        releaseList({});
        await settling;
        expect(settled).toBe(true);
        await expect(settleUploadCleanups()).resolves.toBeUndefined(); // nothing pending
      });
    });

    describe('isIssuedAvatarKey', () => {
      it('accepts only avatars/<id>/<file>', () => {
        expect(isIssuedAvatarKey('avatars/u/a.jpg')).toBe(true);
        expect(isIssuedAvatarKey('avatars/a.jpg')).toBe(false);
        expect(isIssuedAvatarKey('avatars/u/x/a.jpg')).toBe(false);
        expect(isIssuedAvatarKey('other/u/a.jpg')).toBe(false);
        expect(isIssuedAvatarKey('/avatars/u/a.jpg')).toBe(false);
      });
    });

    describe('referencedAvatarKeys', () => {
      it('takes the key from our canonical URL', () => {
        expect(referencedAvatarKeys(`${BUCKET_BASE}u/a.jpg`)).toEqual(['avatars/u/a.jpg']);
      });

      it('ignores the host, so a regional or path-style URL still protects the object', () => {
        expect(referencedAvatarKeys('https://b.s3.us-east-1.amazonaws.com/avatars/u/a.jpg')).toEqual([
          'avatars/u/a.jpg',
        ]);
        expect(referencedAvatarKeys('https://s3.amazonaws.com/b/avatars/u/a.jpg')).toEqual(['avatars/u/a.jpg']);
      });

      it('protects both the raw and the decoded key', () => {
        expect(referencedAvatarKeys(`${BUCKET_BASE}u/a%20b.jpg`)).toEqual(
          expect.arrayContaining(['avatars/u/a%20b.jpg', 'avatars/u/a b.jpg'])
        );
      });

      it('keeps the raw form when the escape is malformed', () => {
        expect(referencedAvatarKeys(`${BUCKET_BASE}u/a%E0.jpg`)).toEqual(['avatars/u/a%E0.jpg']);
      });

      it('falls back to the raw string when the URL does not parse', () => {
        expect(referencedAvatarKeys('not a url avatars/u/a.jpg?x=1')).toEqual(['avatars/u/a.jpg']);
      });

      it('returns nothing for a URL outside avatars/', () => {
        expect(referencedAvatarKeys('https://workos.example/photo.jpg')).toEqual([]);
      });
    });

    describe('loadReferencedAvatarKeys', () => {
      const userId = 'a1b2c3d4-e5f6-4890-a234-567890abcdef';

      it('loads rows whose URL contains the bare id and keys them over-inclusively', async () => {
        (mockPrisma.user.findMany as jest.Mock).mockResolvedValue([
          { profilePictureUrl: `${BUCKET_BASE}${userId}/kid.jpg` },
          // An encoded `avatars/` segment still names the id verbatim, so it loads and decodes
          { profilePictureUrl: `https://bball-tracker-avatars-dev.s3.amazonaws.com/%61vatars/${userId}/enc.jpg` },
          { profilePictureUrl: null },
        ]);

        const keys = await loadReferencedAvatarKeys(userId);

        expect(keys.has(`avatars/${userId}/kid.jpg`)).toBe(true);
        expect(keys.has(`avatars/${userId}/enc.jpg`)).toBe(true);
        // Filtered on the id alone; tombstones included: no deletedAt filter
        expect(mockPrisma.user.findMany).toHaveBeenCalledWith({
          where: { profilePictureUrl: { contains: userId } },
          select: { profilePictureUrl: true },
        });
      });

      it('refuses an id that LIKE would read as a wildcard or that is not a plain segment', async () => {
        await expect(loadReferencedAvatarKeys('a_b')).rejects.toThrow(/plain id/);
        await expect(loadReferencedAvatarKeys('a%b')).rejects.toThrow(/plain id/);
        await expect(loadReferencedAvatarKeys('a/b')).rejects.toThrow(/plain id/);
        expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
      });

      it('propagates a database error', async () => {
        (mockPrisma.user.findMany as jest.Mock).mockRejectedValue(new Error('db down'));
        await expect(loadReferencedAvatarKeys(userId)).rejects.toThrow('db down');
      });
    });

    describe('deleteAvatarKeys', () => {
      it('deletes in batches of 1000 and counts per-key errors', async () => {
        const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
        const keys = Array.from({ length: 1001 }, (_, i) => `avatars/u/${i}.jpg`);
        mockSend
          .mockResolvedValueOnce({
            Errors: [{ Key: 'avatars/u/0.jpg', Code: 'AccessDenied' }],
          })
          .mockResolvedValueOnce({});

        const result = await deleteAvatarKeys(keys);

        expect(result).toEqual({ deleted: 1000, failed: 1, aborted: false });
        const deletes = sentOf('DeleteObjects');
        expect(deletes).toHaveLength(2);
        expect((deletes[0].input.Delete as { Objects: unknown[] }).Objects).toHaveLength(1000);
        expect((deletes[1].input.Delete as { Objects: unknown[] }).Objects).toEqual([{ Key: 'avatars/u/1000.jpg' }]);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ failed: 1, code: 'AccessDenied' })
        );
        warnSpy.mockRestore();
      });

      it('counts a failed batch and never throws', async () => {
        const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
        mockSend.mockRejectedValueOnce(new Error('throttled'));
        await expect(deleteAvatarKeys(['avatars/u/a.jpg'])).resolves.toEqual({ deleted: 0, failed: 1, aborted: false });
        expect(warnSpy).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ error: 'throttled' }));
        warnSpy.mockRestore();
      });

      it('stops between batches once aborted', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(deleteAvatarKeys(['avatars/u/a.jpg'], controller.signal)).resolves.toEqual({ deleted: 0, failed: 0, aborted: true });
        expect(mockSend).not.toHaveBeenCalled();
      });

      it('treats an abort during a batch as a stop, logged at info, not a failed batch', async () => {
        const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
        const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
        const controller = new AbortController();
        mockSend.mockImplementationOnce(async () => {
          controller.abort();
          throw new Error('Request aborted');
        });

        const result = await deleteAvatarKeys(['avatars/u/a.jpg', 'avatars/u/b.jpg'], controller.signal);

        expect(result).toEqual({ deleted: 0, failed: 0, aborted: true });
        expect(warnSpy).not.toHaveBeenCalled();
        expect(infoSpy).toHaveBeenCalledWith(
          'Avatar deletes stopped (aborted)',
          expect.objectContaining({ deleted: 0, notAttempted: 2 })
        );
        expect((mockSend.mock.calls[0][1] as { abortSignal: AbortSignal }).abortSignal).toBe(controller.signal);
        warnSpy.mockRestore();
        infoSpy.mockRestore();
      });

      it('stringifies a non-Error rejection', async () => {
        const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
        mockSend.mockRejectedValueOnce('boom');
        await deleteAvatarKeys(['avatars/u/a.jpg']);
        expect(warnSpy).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ error: 'boom' }));
        warnSpy.mockRestore();
      });
    });

    describe('deleteUnreferencedUserUploads', () => {
      const userId = 'a1b2c3d4-e5f6-4890-a234-567890abcdef';
      // Older than the 1 h floor (ACCOUNT_UPLOAD_MIN_AGE_MS)
      const OLD = new Date(Date.now() - 2 * 60 * 60 * 1000);

      it("deletes the user's uploads that no row references and keeps the ones on a player's row", async () => {
        mockSend
          .mockResolvedValueOnce({
            Contents: [
              { Key: `avatars/${userId}/orphan.jpg`, LastModified: OLD },
              { Key: `avatars/${userId}/kid.jpg`, LastModified: OLD },
              { Key: `avatars/${userId}/nested/odd.jpg`, LastModified: OLD },
            ],
          })
          .mockResolvedValueOnce({});
        (mockPrisma.user.findMany as jest.Mock).mockResolvedValue([
          { profilePictureUrl: `${BUCKET_BASE}${userId}/kid.jpg` },
        ]);

        await deleteUnreferencedUserUploads(userId);

        const list = sentOf('ListObjectsV2');
        expect(list[0].input).toEqual(expect.objectContaining({ Prefix: `avatars/${userId}/` }));
        // References narrowed to rows naming this user's id
        expect(mockPrisma.user.findMany).toHaveBeenCalledWith({
          where: { profilePictureUrl: { contains: userId } },
          select: { profilePictureUrl: true },
        });
        const deletes = sentOf('DeleteObjects');
        expect(deletes).toHaveLength(1);
        expect(deletes[0].input.Delete).toEqual({
          Objects: [{ Key: `avatars/${userId}/orphan.jpg` }],
          Quiet: true,
        });
        // Every S3 call carries the cleanup's timeout signal
        for (const [, options] of mockSend.mock.calls) {
          expect((options as { abortSignal: AbortSignal }).abortSignal).toBeInstanceOf(AbortSignal);
        }
      });

      it('leaves uploads younger than an hour (a save may be in flight) and undated ones', async () => {
        const now = new Date('2026-11-06T12:00:00Z');
        mockSend
          .mockResolvedValueOnce({
            Contents: [
              { Key: `avatars/${userId}/old.jpg`, LastModified: new Date(now.getTime() - ACCOUNT_UPLOAD_MIN_AGE_MS) },
              { Key: `avatars/${userId}/fresh.jpg`, LastModified: new Date(now.getTime() - ACCOUNT_UPLOAD_MIN_AGE_MS + 1) },
              { Key: `avatars/${userId}/undated.jpg` },
            ],
          })
          .mockResolvedValueOnce({});

        await deleteUnreferencedUserUploads(userId, { now });

        expect(sentOf('DeleteObjects')[0].input.Delete).toEqual({
          Objects: [{ Key: `avatars/${userId}/old.jpg` }],
          Quiet: true,
        });
      });

      it('reads no references when every upload is too young', async () => {
        mockSend.mockResolvedValueOnce({ Contents: [{ Key: `avatars/${userId}/fresh.jpg`, LastModified: new Date() }] });
        await deleteUnreferencedUserUploads(userId);
        expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
        expect(sentOf('DeleteObjects')).toHaveLength(0);
      });

      it('deletes nothing when the deadline passes during the reference read', async () => {
        const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
        mockSend.mockResolvedValueOnce({ Contents: [{ Key: `avatars/${userId}/a.jpg`, LastModified: OLD }] });
        (mockPrisma.user.findMany as jest.Mock).mockImplementation(
          () => new Promise((resolve) => setTimeout(() => resolve([]), 30))
        );

        await deleteUnreferencedUserUploads(userId, { timeoutMs: 5 });

        expect(sentOf('DeleteObjects')).toHaveLength(0);
        expect(warnSpy).toHaveBeenCalledWith(
          'Account avatar upload cleanup failed (ignored)',
          expect.objectContaining({ error: expect.stringMatching(/deadline/) })
        );
        warnSpy.mockRestore();
      });

      it('lists one page only, so the request stays bounded', async () => {
        mockSend.mockResolvedValueOnce({
          Contents: [{ Key: `avatars/${userId}/a.jpg`, LastModified: OLD }],
          IsTruncated: true,
          NextContinuationToken: 'more',
        });
        await deleteUnreferencedUserUploads(userId);
        expect(sentOf('ListObjectsV2')).toHaveLength(1);
        expect(sentOf('DeleteObjects')).toHaveLength(1);
      });

      it('gives up, deleting nothing, when S3 outlasts the timeout', async () => {
        const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
        // A list call that only settles when its abort signal fires.
        mockSend.mockImplementationOnce(
          (_cmd: unknown, options: { abortSignal: AbortSignal }) =>
            new Promise((_resolve, reject) => {
              options.abortSignal.addEventListener('abort', () => reject(new Error('Request aborted')));
            })
        );

        await expect(deleteUnreferencedUserUploads(userId, { timeoutMs: 10 })).resolves.toBeUndefined();

        expect(sentOf('DeleteObjects')).toHaveLength(0);
        expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledWith(
          'Account avatar upload cleanup failed (ignored)',
          expect.objectContaining({ error: 'Request aborted' })
        );
        warnSpy.mockRestore();
      });

      it('reads no references and deletes nothing when the prefix is empty', async () => {
        mockSend.mockResolvedValueOnce({});
        await deleteUnreferencedUserUploads(userId);
        expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
        expect(sentOf('DeleteObjects')).toHaveLength(0);
      });

      it('deletes nothing when references cannot be read', async () => {
        const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
        mockSend.mockResolvedValueOnce({
          Contents: [{ Key: `avatars/${userId}/a.jpg`, LastModified: OLD }],
        });
        (mockPrisma.user.findMany as jest.Mock).mockRejectedValue(new Error('db down'));

        await expect(deleteUnreferencedUserUploads(userId)).resolves.toBeUndefined();

        expect(sentOf('DeleteObjects')).toHaveLength(0);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringMatching(/cleanup failed/),
          expect.objectContaining({ error: 'db down' })
        );
        warnSpy.mockRestore();
      });

      it('deletes nothing and never throws when listing is denied (no s3:ListBucket)', async () => {
        const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
        // The shape the SDK rejects with when the task role lacks s3:ListBucket.
        const denied = Object.assign(new Error('Access Denied'), {
          name: 'AccessDenied',
          $metadata: { httpStatusCode: 403 },
        });
        mockSend.mockRejectedValueOnce(denied);
        (mockPrisma.user.findMany as jest.Mock).mockResolvedValue([]);

        await expect(deleteUnreferencedUserUploads(userId)).resolves.toBeUndefined();

        // Nothing deleted, no reference read, one warning.
        expect(sentOf('ListObjectsV2')).toHaveLength(1);
        expect(sentOf('DeleteObjects')).toHaveLength(0);
        expect(sentOf('DeleteObject')).toHaveLength(0);
        expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledWith(
          'Account avatar upload cleanup failed (ignored)',
          expect.objectContaining({ userId, error: 'Access Denied' })
        );
        warnSpy.mockRestore();
      });

      it('stringifies a non-Error listing failure', async () => {
        const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
        mockSend.mockRejectedValueOnce('AccessDenied');
        await expect(deleteUnreferencedUserUploads(userId)).resolves.toBeUndefined();
        expect(sentOf('DeleteObjects')).toHaveLength(0);
        expect(warnSpy).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ error: 'AccessDenied' }));
        warnSpy.mockRestore();
      });

      it('refuses an id that would widen the prefix', async () => {
        const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
        await deleteUnreferencedUserUploads('');
        await deleteUnreferencedUserUploads('a/b');
        await deleteUnreferencedUserUploads('a_b');
        await deleteUnreferencedUserUploads('a%b');
        expect(mockSend).not.toHaveBeenCalled();
        warnSpy.mockRestore();
      });
    });
  });
});
