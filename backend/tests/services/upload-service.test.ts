/**
 * Unit tests for upload-service
 *
 * Covers the presigned POST policy (size cap + content-type pin), avatar
 * deletion and best-effort cleanup of a replaced avatar, with mocked AWS SDK
 * clients.
 */

import { sentOfKind, type SentS3Command } from '../support/s3-mock';

const mockSend = jest.fn().mockResolvedValue({});

jest.mock('@aws-sdk/client-s3', () =>
  jest.requireActual('../support/s3-mock').mockS3ClientModule((...args: unknown[]) => mockSend(...args))
);

/** Inputs of every DeleteObjectCommand sent so far (cleared by `clearAllMocks`). */
const deleteObjectCalls = (): Record<string, unknown>[] => sentOfKind(mockSend, 'DeleteObject').map((c) => c.input);

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
  deletePreviousAvatar,
  deleteUnreferencedUserUploads,
  skippedAvatarCleanup,
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

      expect(deleteObjectCalls()).toHaveLength(1);
      expect(deleteObjectCalls()[0]).toEqual({
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
      expect(deleteObjectCalls()).toEqual([{ Bucket: 'bball-tracker-avatars-dev', Key: 'avatars/u/old.jpg' }]);
    });

    it('deletes the previous object when the avatar is cleared', async () => {
      await deletePreviousAvatar(`${BUCKET_BASE}u/old.jpg`, null);
      expect(deleteObjectCalls()).toHaveLength(1);
    });

    it('is a no-op when the URL did not change', async () => {
      await deletePreviousAvatar(`${BUCKET_BASE}u/same.jpg`, `${BUCKET_BASE}u/same.jpg`);
      expect(deleteObjectCalls()).toHaveLength(0);
    });

    it('never touches objects outside our bucket (e.g. WorkOS profile photos)', async () => {
      await deletePreviousAvatar('https://workos.example/photo.jpg', `${BUCKET_BASE}u/new.jpg`);
      expect(deleteObjectCalls()).toHaveLength(0);
    });

    it('is a no-op when there was no previous avatar', async () => {
      await deletePreviousAvatar(null, `${BUCKET_BASE}u/new.jpg`);
      expect(deleteObjectCalls()).toHaveLength(0);
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

        expect(deleteObjectCalls()).toHaveLength(0);
        expect(mockSend).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringMatching(/not an issued upload key/),
          expect.not.objectContaining({ previousUrl: expect.anything() })
        );
        expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('any-key');
      });

      it('still deletes a key of the issued shape', async () => {
        await deletePreviousAvatar(`${BUCKET_BASE}${a}/pic.jpg`, null);
        expect(deleteObjectCalls()).toEqual([{ Bucket: 'bball-tracker-avatars-dev', Key: `avatars/${a}/pic.jpg` }]);
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

      expect(deleteObjectCalls()).toEqual([
        { Bucket: 'bball-tracker-avatars-dev', Key: `avatars/${callerId}/pic.jpg` },
      ]);
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('never deletes an object under another user\'s prefix (client-supplied URL)', async () => {
      await discardOwnAvatar(`${BUCKET_BASE}${otherId}/pic.jpg`, callerId);

      expect(deleteObjectCalls()).toHaveLength(0);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('does not let a prefix-sharing id match (avatars/<id>-suffix/)', async () => {
      await discardOwnAvatar(`${BUCKET_BASE}${callerId}-x/pic.jpg`, callerId);
      expect(deleteObjectCalls()).toHaveLength(0);
    });

    it('checks ownership on the normalised path, so a ../ hop out of the own prefix deletes nothing', async () => {
      // URL parsing collapses `..` (and `%2e%2e`) before the key is derived
      await discardOwnAvatar(`${BUCKET_BASE}${callerId}/../${otherId}/pic.jpg`, callerId);
      await discardOwnAvatar(`${BUCKET_BASE}${callerId}/%2e%2e/${otherId}/pic.jpg`, callerId);

      expect(deleteObjectCalls()).toHaveLength(0);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('never touches objects outside our bucket', async () => {
      await discardOwnAvatar('https://workos.example/photo.jpg', callerId);
      await discardOwnAvatar(`https://evil.example/avatars/${callerId}/pic.jpg`, callerId);

      expect(deleteObjectCalls()).toHaveLength(0);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('is a no-op without a URL', async () => {
      await discardOwnAvatar(undefined, callerId);
      await discardOwnAvatar(null, callerId);
      expect(deleteObjectCalls()).toHaveLength(0);
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
  // Unreferenced uploads on account deletion (#957)
  // -------------------------------------------------------------------------

  describe('unreferenced uploads (#957)', () => {
    const userId = 'a1b2c3d4-e5f6-4890-a234-567890abcdef';
    let warnSpy: jest.SpyInstance;
    let infoSpy: jest.SpyInstance;

    beforeEach(() => {
      // `clearAllMocks` keeps queued `…Once` values; start each case clean.
      mockSend.mockReset();
      mockSend.mockResolvedValue({});
      (mockPrisma.user.findMany as jest.Mock).mockReset();
      (mockPrisma.user.findMany as jest.Mock).mockResolvedValue([]);
      warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
      infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    });

    afterEach(() => {
      warnSpy.mockRestore();
      infoSpy.mockRestore();
    });

    type Sent = SentS3Command;
    const sentOf = (kind: string): Sent[] => sentOfKind(mockSend, kind);
    const deletedKeys = (): string[] =>
      sentOf('DeleteObjects').flatMap((c) => (c.input.Delete as { Objects: { Key: string }[] }).Objects.map((o) => o.Key));
    const key = (file: string): string => `avatars/${userId}/${file}`;
    /** S3 answers ListObjectsV2 with `pages` in order and DeleteObjects with `{}`. */
    function listing(...pages: Record<string, unknown>[]): void {
      const queue = [...pages];
      mockSend.mockImplementation(async (cmd: Sent) => (cmd.kind === 'ListObjectsV2' ? (queue.shift() ?? {}) : {}));
    }
    /** A send that settles only when its abort signal fires. */
    const hangUntilAborted = (_cmd: unknown, options: { abortSignal: AbortSignal }): Promise<never> =>
      new Promise((_resolve, reject) => {
        options.abortSignal.addEventListener('abort', () => reject(new Error('Request aborted')));
      });

    describe('skippedAvatarCleanup', () => {
      it('reports zero counts and the reason', () => {
        expect(skippedAvatarCleanup('why')).toEqual({
          listed: 0,
          kept: 0,
          deleted: 0,
          failed: 0,
          unknown: 0,
          incomplete: false,
          skipped: 'why',
        });
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

      it('takes a key from every avatars/ occurrence, so a bucket named *avatars still protects the real key', () => {
        // Path-style URL for a bucket whose name ends in "avatars"
        expect(referencedAvatarKeys('https://s3.amazonaws.com/team-avatars/avatars/u/a.jpg')).toEqual(
          expect.arrayContaining(['avatars/u/a.jpg'])
        );
        expect(referencedAvatarKeys('https://s3.amazonaws.com/avatars/avatars/u/a.jpg')).toEqual(
          expect.arrayContaining(['avatars/avatars/u/a.jpg', 'avatars/u/a.jpg'])
        );
      });

      it('returns nothing for a URL outside avatars/', () => {
        expect(referencedAvatarKeys('https://workos.example/photo.jpg')).toEqual([]);
      });
    });

    describe('loadReferencedAvatarKeys', () => {
      it('loads rows whose URL contains the bare id and keys them over-inclusively', async () => {
        (mockPrisma.user.findMany as jest.Mock).mockResolvedValue([
          { profilePictureUrl: `${BUCKET_BASE}${userId}/kid.jpg` },
          // An encoded `avatars/` segment still names the id verbatim, so it loads and decodes
          { profilePictureUrl: `https://bball-tracker-avatars-dev.s3.amazonaws.com/%61vatars/${userId}/enc.jpg` },
          { profilePictureUrl: null },
        ]);

        const keys = await loadReferencedAvatarKeys(userId);

        expect(keys.has(key('kid.jpg'))).toBe(true);
        expect(keys.has(key('enc.jpg'))).toBe(true);
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

    describe('deleteUnreferencedUserUploads', () => {
      it("deletes the user's unreferenced uploads, keeps the ones on a player's row, and logs counts at info", async () => {
        listing({ Contents: [{ Key: key('orphan.jpg') }, { Key: key('kid.jpg') }, { Key: key('nested/odd.jpg') }, {}] });
        (mockPrisma.user.findMany as jest.Mock).mockResolvedValue([
          { profilePictureUrl: `${BUCKET_BASE}${userId}/kid.jpg` },
        ]);

        const result = await deleteUnreferencedUserUploads(userId);

        // The nested key is the user's own too: unreferenced, so deleted. Counts add up.
        expect(result).toEqual({ listed: 3, kept: 1, deleted: 2, failed: 0, unknown: 0, incomplete: false });
        expect(result.listed).toBe(result.kept + result.deleted + result.failed + result.unknown);
        expect(sentOf('ListObjectsV2')[0].input).toEqual(expect.objectContaining({ Prefix: `avatars/${userId}/` }));
        expect(deletedKeys()).toEqual([key('orphan.jpg'), key('nested/odd.jpg')]);
        expect(sentOf('DeleteObjects')[0].input.Delete).toEqual(expect.objectContaining({ Quiet: true }));
        // Every S3 call carries the deadline's signal
        for (const [, options] of mockSend.mock.calls) {
          expect((options as { abortSignal: AbortSignal }).abortSignal).toBeInstanceOf(AbortSignal);
        }
        expect(infoSpy).toHaveBeenCalledWith('Account avatar uploads cleaned up', { userId, ...result });
        expect(warnSpy).not.toHaveBeenCalled();
      });

      it('lists every page, then reads references once, then deletes', async () => {
        const order: string[] = [];
        listing(
          { Contents: [{ Key: key('a.jpg') }], IsTruncated: true, NextContinuationToken: 'p2' },
          { Contents: [{ Key: key('b.jpg') }], IsTruncated: true, NextContinuationToken: 'p3' },
          { Contents: [{ Key: key('c.jpg') }] }
        );
        const send = mockSend.getMockImplementation() as (cmd: Sent) => Promise<unknown>;
        mockSend.mockImplementation(async (cmd: Sent) => {
          order.push(cmd.kind);
          return send(cmd);
        });
        (mockPrisma.user.findMany as jest.Mock).mockImplementation(async () => {
          order.push('refs');
          return [];
        });

        const result = await deleteUnreferencedUserUploads(userId);

        expect(order).toEqual(['ListObjectsV2', 'ListObjectsV2', 'ListObjectsV2', 'refs', 'DeleteObjects']);
        expect(sentOf('ListObjectsV2').map((c) => c.input.ContinuationToken)).toEqual([undefined, 'p2', 'p3']);
        expect(deletedKeys()).toEqual([key('a.jpg'), key('b.jpg'), key('c.jpg')]);
        expect(result.deleted).toBe(3);
      });

      it('keeps a nested key a profile references', async () => {
        listing({ Contents: [{ Key: key('nested/kept.jpg') }] });
        (mockPrisma.user.findMany as jest.Mock).mockResolvedValue([
          { profilePictureUrl: `${BUCKET_BASE}${userId}/nested/kept.jpg` },
        ]);
        const result = await deleteUnreferencedUserUploads(userId);
        expect(result).toEqual(expect.objectContaining({ listed: 1, kept: 1, deleted: 0 }));
        expect(sentOf('DeleteObjects')).toHaveLength(0);
      });

      it('never deletes a listed key outside the prefix', async () => {
        listing({ Contents: [{ Key: 'avatars/someone-else/x.jpg' }] });
        const result = await deleteUnreferencedUserUploads(userId);
        expect(sentOf('DeleteObjects')).toHaveLength(0);
        expect(result).toEqual(expect.objectContaining({ listed: 1, kept: 0, deleted: 0 }));
      });

      it('deletes regardless of age (no floor)', async () => {
        listing({ Contents: [{ Key: key('just-now.jpg'), LastModified: new Date() }] });
        await deleteUnreferencedUserUploads(userId);
        expect(deletedKeys()).toEqual([key('just-now.jpg')]);
      });

      it('deletes in batches of 1000 and counts per-key errors', async () => {
        const keys = Array.from({ length: 1001 }, (_, i) => ({ Key: key(`${i}.jpg`) }));
        const deletes = [{ Errors: [{ Key: key('0.jpg'), Code: 'AccessDenied' }] }, {}];
        mockSend.mockImplementation(async (cmd: Sent) =>
          cmd.kind === 'ListObjectsV2' ? { Contents: keys } : deletes.shift()
        );

        const result = await deleteUnreferencedUserUploads(userId);

        expect(sentOf('DeleteObjects')).toHaveLength(2);
        expect(deletedKeys()).toHaveLength(1001);
        expect(result).toEqual(expect.objectContaining({ deleted: 1000, failed: 1, unknown: 0, incomplete: false }));
        expect(warnSpy).toHaveBeenCalledWith(
          'Some avatar objects could not be deleted',
          expect.objectContaining({ failed: 1, code: 'AccessDenied' })
        );
        expect(warnSpy).toHaveBeenCalledWith(
          'Account avatar upload cleanup did not finish cleanly',
          expect.objectContaining({ userId, failed: 1 })
        );
      });

      it('counts a failed batch as failed and goes on', async () => {
        mockSend.mockImplementation(async (cmd: Sent) => {
          if (cmd.kind === 'ListObjectsV2') return { Contents: [{ Key: key('a.jpg') }] };
          throw 'throttled';
        });
        const result = await deleteUnreferencedUserUploads(userId);
        expect(result).toEqual(expect.objectContaining({ deleted: 0, failed: 1, unknown: 0, incomplete: false }));
        expect(warnSpy).toHaveBeenCalledWith('Avatar batch delete failed', expect.objectContaining({ error: 'throttled' }));
      });

      it('reports the keys of a DeleteObjects call the deadline aborted as unknown, and the rest as not attempted', async () => {
        const keys = Array.from({ length: 1500 }, (_, i) => ({ Key: key(`${i}.jpg`) }));
        mockSend.mockImplementation((cmd: Sent, options: { abortSignal: AbortSignal }) =>
          cmd.kind === 'ListObjectsV2' ? Promise.resolve({ Contents: keys }) : hangUntilAborted(cmd, options)
        );

        const result = await deleteUnreferencedUserUploads(userId, { timeoutMs: 20 });

        expect(sentOf('DeleteObjects')).toHaveLength(1); // the second batch is never sent
        expect(result).toEqual({ listed: 1500, kept: 0, deleted: 0, failed: 0, unknown: 1000, incomplete: true });
        expect(warnSpy).toHaveBeenCalledWith(
          'Account avatar upload cleanup did not finish cleanly',
          expect.objectContaining({ userId, unknown: 1000, incomplete: true })
        );
        expect(warnSpy).not.toHaveBeenCalledWith('Avatar batch delete failed', expect.anything());
      });

      it('stops before the next batch once the deadline has passed', async () => {
        const keys = Array.from({ length: 1500 }, (_, i) => ({ Key: key(`${i}.jpg`) }));
        mockSend.mockImplementation(async (cmd: Sent) => {
          if (cmd.kind === 'ListObjectsV2') return { Contents: keys };
          await new Promise((resolve) => setTimeout(resolve, 30)); // outlives the deadline, then succeeds
          return {};
        });

        const result = await deleteUnreferencedUserUploads(userId, { timeoutMs: 10 });

        expect(sentOf('DeleteObjects')).toHaveLength(1);
        expect(result).toEqual(expect.objectContaining({ deleted: 1000, unknown: 0, incomplete: true }));
      });

      it('marks the run incomplete and deletes nothing when the deadline cuts the listing short', async () => {
        mockSend
          .mockResolvedValueOnce({ Contents: [{ Key: key('a.jpg') }], IsTruncated: true, NextContinuationToken: 'p2' })
          .mockImplementationOnce(hangUntilAborted);

        const result = await deleteUnreferencedUserUploads(userId, { timeoutMs: 10 });

        expect(result).toEqual({ listed: 1, kept: 0, deleted: 0, failed: 0, unknown: 0, incomplete: true });
        expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
        expect(sentOf('DeleteObjects')).toHaveLength(0);
        expect(warnSpy).toHaveBeenCalledWith(
          'Account avatar upload cleanup did not finish cleanly',
          expect.objectContaining({ incomplete: true })
        );
      });

      it('deletes nothing when the deadline passes during the reference read', async () => {
        listing({ Contents: [{ Key: key('a.jpg') }] });
        (mockPrisma.user.findMany as jest.Mock).mockImplementation(
          () => new Promise((resolve) => setTimeout(() => resolve([]), 30))
        );

        const result = await deleteUnreferencedUserUploads(userId, { timeoutMs: 5 });

        expect(sentOf('DeleteObjects')).toHaveLength(0);
        expect(result).toEqual(expect.objectContaining({ deleted: 0, incomplete: true }));
      });

      it('reads no references and deletes nothing when the prefix is empty', async () => {
        const result = await deleteUnreferencedUserUploads(userId);
        expect(result).toEqual({ listed: 0, kept: 0, deleted: 0, failed: 0, unknown: 0, incomplete: false });
        expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
        expect(sentOf('DeleteObjects')).toHaveLength(0);
      });

      it('deletes nothing and reports the error when references cannot be read', async () => {
        listing({ Contents: [{ Key: key('a.jpg') }] });
        (mockPrisma.user.findMany as jest.Mock).mockRejectedValue(new Error('db down'));

        const result = await deleteUnreferencedUserUploads(userId);

        expect(sentOf('DeleteObjects')).toHaveLength(0);
        expect(result).toEqual(expect.objectContaining({ deleted: 0, incomplete: false, error: 'db down' }));
        expect(warnSpy).toHaveBeenCalledWith(
          'Account avatar upload cleanup did not finish cleanly',
          expect.objectContaining({ userId, error: 'db down' })
        );
      });

      it('deletes nothing and never throws when listing is denied (no s3:ListBucket)', async () => {
        // The shape the SDK rejects with when the task role lacks s3:ListBucket.
        const denied = Object.assign(new Error('Access Denied'), {
          name: 'AccessDenied',
          $metadata: { httpStatusCode: 403 },
        });
        mockSend.mockRejectedValueOnce(denied);

        const result = await deleteUnreferencedUserUploads(userId);

        expect(result).toEqual({
          listed: 0,
          kept: 0,
          deleted: 0,
          failed: 0,
          unknown: 0,
          incomplete: false,
          error: 'Access Denied',
        });
        expect(sentOf('ListObjectsV2')).toHaveLength(1);
        expect(sentOf('DeleteObjects')).toHaveLength(0);
        expect(sentOf('DeleteObject')).toHaveLength(0);
        expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
      });

      it('stringifies a non-Error listing failure', async () => {
        mockSend.mockRejectedValueOnce('AccessDenied');
        const result = await deleteUnreferencedUserUploads(userId);
        expect(result.error).toBe('AccessDenied');
      });

      it('refuses an id that would widen the prefix or act as a LIKE wildcard', async () => {
        for (const bad of ['', 'a/b', 'a_b', 'a%b']) {
          await expect(deleteUnreferencedUserUploads(bad)).resolves.toEqual(
            expect.objectContaining({ listed: 0, error: 'user id is not a safe key segment' })
          );
        }
        expect(mockSend).not.toHaveBeenCalled();
      });
    });
  });
});
