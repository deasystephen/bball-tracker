import {
  S3Client,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { randomUUID } from 'crypto';
import prisma from '../models';
import { BadRequestError } from '../utils/errors';
import { logger } from '../utils/logger';

const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
});

const BUCKET_NAME = process.env.S3_AVATARS_BUCKET || 'bball-tracker-avatars-dev';
const BUCKET_URL_PREFIX = `https://${BUCKET_NAME}.s3.amazonaws.com/avatars/`;

/** Hard cap on avatar size, enforced by the S3 POST policy (audit #61). */
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

/** Presigned upload validity (seconds). */
const UPLOAD_EXPIRES_SECONDS = 300;

const CONTENT_TYPE_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

export interface AvatarUploadTarget {
  /** S3 endpoint the client must `POST` a multipart form to. */
  uploadUrl: string;
  /** Form fields that must accompany the `file` part (policy + signature). */
  fields: Record<string, string>;
  /** Public URL the object will have once uploaded. */
  imageUrl: string;
}

/**
 * Create a presigned S3 POST (not PUT) for an avatar upload.
 *
 * A presigned PUT cannot bind `Content-Length` (SigV4 never signs it), so the
 * object size was unbounded. A POST policy carries a `content-length-range`
 * condition that S3 enforces server-side, plus an exact `Content-Type` match.
 */
export async function generateAvatarUploadUrl(
  userId: string,
  contentType: string,
  contentLength?: number
): Promise<AvatarUploadTarget> {
  const ext = CONTENT_TYPE_TO_EXT[contentType];
  if (!ext) {
    throw new Error(`Unsupported content type: ${contentType}`);
  }
  if (contentLength !== undefined && (contentLength < 1 || contentLength > MAX_AVATAR_BYTES)) {
    throw new Error(`Avatar must be between 1 byte and ${MAX_AVATAR_BYTES} bytes`);
  }

  const key = `avatars/${userId}/${randomUUID()}.${ext}`;

  const { url, fields } = await createPresignedPost(s3Client, {
    Bucket: BUCKET_NAME,
    Key: key,
    Conditions: [
      ['content-length-range', 1, MAX_AVATAR_BYTES],
      ['eq', '$Content-Type', contentType],
    ],
    Fields: { 'Content-Type': contentType },
    Expires: UPLOAD_EXPIRES_SECONDS,
  });

  const imageUrl = `https://${BUCKET_NAME}.s3.amazonaws.com/${key}`;

  return { uploadUrl: url, fields, imageUrl };
}

/** True when `imageUrl` points at an object in our avatars bucket. */
export function isManagedAvatarUrl(imageUrl: string | null | undefined): imageUrl is string {
  return typeof imageUrl === 'string' && imageUrl.startsWith(BUCKET_URL_PREFIX);
}

/**
 * The path of `imageUrl` as the URL parser normalises it, or `null` when it
 * does not parse. Every ownership and shape check below runs on THIS value,
 * never on the raw string: `deleteAvatar` derives the object key from
 * `URL.pathname`, which collapses `..` and `%2e%2e` segments, so a raw
 * `avatars/<me>/../<other>/x.jpg` passes a string prefix check and names
 * `<other>`'s object.
 */
function parsedPath(imageUrl: string): string | null {
  try {
    return new URL(imageUrl).pathname;
  } catch {
    return null;
  }
}

/**
 * The only key shape `generateAvatarUploadUrl` ever issues:
 * `avatars/<userId>/<file>`, exactly two segments under `avatars/`.
 */
const ISSUED_KEY_PATH = /^\/avatars\/[^/]+\/[^/]+$/;

/**
 * True when `callerId` may store `imageUrl` as a `profilePictureUrl` (#717).
 *
 * `profilePictureUrl` is client-supplied and nothing else ties it to the
 * caller, while `deletePreviousAvatar` later deletes whatever the row holds.
 * Without this gate any signed-in user could store another user's avatar URL
 * (visible in roster payloads) and clear it, deleting the other user's object.
 *
 * Allowed: a URL outside our bucket (WorkOS profile photos and the like are
 * never deleted, see `isManagedAvatarUrl`), or an object under the caller's
 * own upload prefix `avatars/<callerId>/`, the prefix `POST
 * /uploads/avatar-url` presigns for them. The check is on the caller, not on
 * the row being written: a coach legitimately uploads a managed player's
 * photo under the coach's prefix and writes it onto the player's row.
 */
export function isOwnUploadUrl(imageUrl: string | null | undefined, callerId: string): boolean {
  if (!isManagedAvatarUrl(imageUrl)) {
    return true;
  }
  const path = parsedPath(imageUrl);
  return path !== null && path.startsWith(`/avatars/${callerId}/`) && ISSUED_KEY_PATH.test(path);
}

/**
 * The write-time gate for every path that persists a `profilePictureUrl`
 * (`PATCH /auth/me`, create/update player, roster Add Player). A foreign key
 * in our bucket is malformed input, not an authorisation decision about a
 * resource, hence 400.
 */
export function assertOwnUploadUrl(imageUrl: string | null | undefined, callerId: string): void {
  if (!isOwnUploadUrl(imageUrl, callerId)) {
    throw new BadRequestError('profilePictureUrl must be an upload issued to the caller');
  }
}

export async function deleteAvatar(imageUrl: string): Promise<void> {
  const url = new URL(imageUrl);
  const key = url.pathname.startsWith('/') ? url.pathname.slice(1) : url.pathname;

  const command = new DeleteObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
  });

  await s3Client.send(command);
}

/**
 * Best-effort removal of the avatar object that `nextUrl` replaces, so every
 * avatar change doesn't leave the previous object orphaned in S3 (audit #61).
 * Only objects in our bucket are touched; failures are logged, never thrown —
 * the profile update has already succeeded.
 *
 * Defence in depth behind `assertOwnUploadUrl` (#717): the stored URL may
 * predate the write-time gate, so the delete is also refused unless the
 * parsed path has the exact issued shape `/avatars/<id>/<file>`. A URL whose
 * `..` segments would collapse the key outside `avatars/` (or into a
 * different shape) deletes nothing and leaves a warning. No owner id is
 * checked here: the row's owner is not always the uploader (coach-uploaded
 * player photos), which is why the gate sits at write time.
 */
export async function deletePreviousAvatar(
  previousUrl: string | null | undefined,
  nextUrl: string | null | undefined
): Promise<void> {
  if (!isManagedAvatarUrl(previousUrl) || previousUrl === nextUrl) {
    return;
  }

  const path = parsedPath(previousUrl);
  if (path === null || !ISSUED_KEY_PATH.test(path)) {
    // Never the URL itself: it is client-supplied and this is the hostile case.
    logger.warn('Previous avatar URL is not an issued upload key; not deleted', {
      reason: path === null ? 'unparsable' : 'path outside avatars/<id>/<file>',
    });
    return;
  }

  try {
    await deleteAvatar(previousUrl);
  } catch (err) {
    logger.warn('Failed to delete previous avatar object (ignored)', {
      previousUrl,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Best-effort removal of an avatar object the caller uploaded but that will
 * never be referenced (a case-3 Add Player creates an invitation only, so the
 * photo uploaded ahead of the request would otherwise be orphaned, #419).
 *
 * `imageUrl` is client-supplied, so this deletes only when the key sits under
 * the caller's own upload prefix `avatars/<userId>/` (the shape
 * `generateAvatarUploadUrl` issues); any other URL is ignored, or a coach could
 * name another user's avatar and have it deleted. Failures are logged, never
 * thrown — the invitation has already been created and emailed.
 */
export async function discardOwnAvatar(
  imageUrl: string | null | undefined,
  userId: string
): Promise<void> {
  // Same ownership rule as the write-time gate, on the parsed path (see
  // `isOwnUploadUrl`); a URL outside our bucket is not ours to delete.
  if (!isManagedAvatarUrl(imageUrl) || !isOwnUploadUrl(imageUrl, userId)) {
    return;
  }

  try {
    await deleteAvatar(imageUrl);
  } catch (err) {
    logger.warn('Failed to discard unreferenced avatar object (ignored)', {
      imageUrl,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Unreferenced uploads on account deletion (#957)
//
// An upload exists in the public bucket as soon as the POST finishes, before
// any profile write stores its URL. When an account is deleted, the helpers
// below find and delete that user's own uploads that no
// `User.profilePictureUrl` references. They need `s3:ListBucket` on the bucket
// (task role, `infra/ecs.tf`); without it the list call is denied, the cleanup
// reports it, and nothing is deleted. Uploads never saved by users who keep
// their accounts are not collected here (#1005).
// ---------------------------------------------------------------------------

/** DeleteObjects takes at most 1000 keys per request. */
const DELETE_BATCH_SIZE = 1000;

/**
 * Deadline for the cleanup inside `deleteAccount`. It starts only after the
 * transaction and the WorkOS step, and the mobile client gives the whole
 * request 10 s, so it stays short: a slow S3 must not turn a completed
 * deletion into an error on the phone. What it cannot finish is reported as
 * `incomplete` and re-run by the operator
 * (`data-subject-request.ts cleanup-avatars`, with a longer deadline).
 */
export const ACCOUNT_UPLOAD_CLEANUP_TIMEOUT_MS = 3_000;

/**
 * User ids become an S3 prefix and a LIKE fragment. They are UUIDs; anything
 * else (a `/` that widens the prefix, a `%` or `_` that LIKE reads as a
 * wildcard) skips the cleanup. A UUID has no character a URL ever
 * percent-encodes, so a stored URL always carries it verbatim.
 */
const SAFE_ID = /^[A-Za-z0-9-]+$/;

/** What one cleanup did. Logged by the cleanup, printed by the operator CLI. */
export interface AvatarCleanupResult {
  /** Objects listed under `avatars/<userId>/`. */
  listed: number;
  /** Issued keys still referenced by some profile, left in place. */
  kept: number;
  deleted: number;
  /** Keys S3 reported as not deleted. */
  failed: number;
  /** Keys in a DeleteObjects call the deadline aborted: deleted or not, S3 never said. */
  unknown: number;
  /** True when the deadline cut the cleanup short (listing, reference read or deletes). */
  incomplete: boolean;
  /** Set when the cleanup did not run or a read failed (nothing more was deleted). */
  error?: string;
  /** Set when there was nothing to clean by construction (the reason); no S3 call was made. */
  skipped?: string;
}

/** The result for an account that cannot have uploads of its own. */
export function skippedAvatarCleanup(reason: string): AvatarCleanupResult {
  return { listed: 0, kept: 0, deleted: 0, failed: 0, unknown: 0, incomplete: false, skipped: reason };
}

/**
 * Every object key a stored `profilePictureUrl` could be pointing at.
 *
 * Deliberately over-inclusive, because a miss deletes a photo that is in use
 * and the bucket is unversioned: the host is ignored (a regional or path-style
 * URL to our bucket still protects its object), both the raw and the
 * percent-decoded path count, and a key is taken from EVERY `avatars/`
 * occurrence in the path, so a path-style URL whose bucket name ends in
 * `avatars` (`/<x>-avatars/avatars/<id>/f.jpg`) still yields the real key.
 * The path comes from `parsedPath`, the same parser every other check uses;
 * an unparsable value falls back to the raw string minus query and fragment.
 *
 * Accepted consequence: because the host is ignored, a row pointing at some
 * OTHER bucket's `avatars/<A>/f.jpg` (or any user storing a URL that names
 * A's key) keeps A's object alive. Keeping is the safe direction; protecting
 * a key that does not exist, or one we could have deleted, costs nothing.
 */
export function referencedAvatarKeys(storedUrl: string): string[] {
  const pathname = parsedPath(storedUrl) ?? storedUrl.split(/[?#]/)[0];
  const paths = new Set<string>([pathname]);
  try {
    paths.add(decodeURIComponent(pathname));
  } catch {
    // Malformed escape: the raw form is already in the set.
  }

  const keys = new Set<string>();
  for (const path of paths) {
    for (let at = path.indexOf('avatars/'); at !== -1; at = path.indexOf('avatars/', at + 1)) {
      keys.add(path.slice(at));
    }
  }
  return [...keys];
}

/**
 * The object keys referenced by any `User.profilePictureUrl` that contains
 * `userId`, tombstones and every row included. Throws on a database error, so
 * a caller can never mistake "could not read references" for "nothing is
 * referenced".
 *
 * Filtering on the bare id, not `avatars/<id>/`, is what makes the narrowing
 * safe: a UUID has no character a URL percent-encodes, so every stored URL
 * naming an object under the user's prefix contains it verbatim, however the
 * rest of the URL is spelled. `contains` compiles to LIKE, hence `SAFE_ID`
 * (no `%` or `_`). What loads is matched over-inclusively
 * (`referencedAvatarKeys`).
 */
export async function loadReferencedAvatarKeys(userId: string): Promise<Set<string>> {
  if (!SAFE_ID.test(userId)) {
    throw new Error('Reference filter must be a plain id');
  }
  // `LIKE '%<id>%'` is a sequential scan of "User"; acceptable because it runs
  // once per account deletion (rare) against a table of this app's size.
  const rows = await prisma.user.findMany({
    where: { profilePictureUrl: { contains: userId } },
    select: { profilePictureUrl: true },
  });
  const keys = new Set<string>();
  for (const { profilePictureUrl } of rows) {
    if (profilePictureUrl) {
      for (const key of referencedAvatarKeys(profilePictureUrl)) {
        keys.add(key);
      }
    }
  }
  return keys;
}

/**
 * Delete `keys` in batches of 1000 into `result`. A failed batch or a
 * per-key error counts as `failed` and is logged (no keys in the line). When
 * the deadline aborts an in-flight batch, its keys count as `unknown` (S3
 * may or may not have applied it) and the rest are not attempted; both set
 * `incomplete`.
 */
async function deleteKeys(keys: string[], signal: AbortSignal, result: AvatarCleanupResult): Promise<void> {
  for (let i = 0; i < keys.length; i += DELETE_BATCH_SIZE) {
    if (signal.aborted) {
      result.incomplete = true;
      return;
    }
    const batch = keys.slice(i, i + DELETE_BATCH_SIZE);
    try {
      const response = await s3Client.send(
        new DeleteObjectsCommand({
          Bucket: BUCKET_NAME,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        }),
        { abortSignal: signal }
      );
      const errors = response.Errors?.length ?? 0;
      result.failed += errors;
      result.deleted += batch.length - errors;
      if (errors > 0) {
        logger.warn('Some avatar objects could not be deleted', {
          operation: 'DeleteObjects',
          failed: errors,
          code: response.Errors?.[0]?.Code,
        });
      }
    } catch (err) {
      if (signal.aborted) {
        result.unknown += batch.length;
        result.incomplete = true;
        return;
      }
      result.failed += batch.length;
      logger.warn('Avatar batch delete failed', {
        operation: 'DeleteObjects',
        failed: batch.length,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Delete the objects under `avatars/<userId>/` that no
 * `User.profilePictureUrl` references (#957). A coach or guardian uploads a
 * player's photo under their OWN prefix and writes it onto the player's row,
 * so the prefix can hold photos in use elsewhere; those stay.
 *
 * Awaited by `AccountService.deleteAccount` after commit and after the WorkOS
 * step, and re-run by the operator (`data-subject-request.ts cleanup-avatars`)
 * when a deletion's log shows it failed or was `incomplete`. Never throws: the
 * outcome is the returned result, logged at info when complete and at warn
 * otherwise. Order: list every page (within the deadline), then read
 * references, then delete. A failed or cut-short listing or reference read
 * deletes nothing.
 *
 * Accepted race: an admin deleting a coach while that coach's profile save is
 * in flight can delete the just-uploaded photo before the row references it.
 * Rare, admin-only, and the photo is the deleted coach's own upload.
 */
export async function deleteUnreferencedUserUploads(
  userId: string,
  { timeoutMs = ACCOUNT_UPLOAD_CLEANUP_TIMEOUT_MS }: { timeoutMs?: number } = {}
): Promise<AvatarCleanupResult> {
  const result: AvatarCleanupResult = { listed: 0, kept: 0, deleted: 0, failed: 0, unknown: 0, incomplete: false };
  if (!SAFE_ID.test(userId)) {
    result.error = 'user id is not a safe key segment';
    logger.warn('Account avatar upload cleanup skipped', { userId, reason: result.error });
    return result;
  }

  const prefix = `avatars/${userId}/`;
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await s3Client.send(
        new ListObjectsV2Command({ Bucket: BUCKET_NAME, Prefix: prefix, ContinuationToken: continuationToken }),
        { abortSignal: signal }
      );
      for (const item of page.Contents ?? []) {
        if (item.Key) {
          result.listed += 1;
          keys.push(item.Key);
        }
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);

    // Every key under the user's own prefix is a candidate, whatever its shape
    // (it is that user's prefix), so the counts add up:
    // listed = kept + deleted + failed + unknown (+ not attempted when incomplete).
    const candidates = keys.filter((key) => key.startsWith(prefix));
    if (candidates.length > 0) {
      // References are read AFTER listing, so they are at least as fresh as the list.
      const referenced = await loadReferencedAvatarKeys(userId);
      if (signal.aborted) {
        // The reference read cannot be aborted; never delete past the deadline.
        throw new Error('deadline passed before delete');
      }
      const orphans = candidates.filter((key) => !referenced.has(key));
      result.kept = candidates.length - orphans.length;
      await deleteKeys(orphans, signal, result);
    }
  } catch (err) {
    if (signal.aborted) {
      result.incomplete = true;
    } else {
      result.error = err instanceof Error ? err.message : String(err);
    }
  }

  const { error, ...counts } = result;
  if (error !== undefined || result.incomplete || result.failed > 0) {
    logger.warn('Account avatar upload cleanup did not finish cleanly', {
      userId,
      operation: 'ListObjectsV2/DeleteObjects',
      ...counts,
      ...(error !== undefined && { error }),
    });
  } else {
    logger.info('Account avatar uploads cleaned up', { userId, ...counts });
  }
  return result;
}
