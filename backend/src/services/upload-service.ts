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
// Unreferenced uploads (#957)
//
// An upload exists in the public bucket as soon as the POST finishes, before
// any profile write stores its URL. The helpers below find and delete objects
// that no `User.profilePictureUrl` references. They need `s3:ListBucket` on
// the bucket (task role, `infra/ecs.tf`); without it the list call is denied,
// the caller logs it, and nothing is deleted.
// ---------------------------------------------------------------------------

/** Every object key under `avatars/` that `generateAvatarUploadUrl` can issue. */
const ISSUED_KEY = /^avatars\/[^/]+\/[^/]+$/;

/** DeleteObjects takes at most 1000 keys per request. */
const DELETE_BATCH_SIZE = 1000;

export interface AvatarObject {
  key: string;
  lastModified: Date | undefined;
}

export interface AvatarDeleteResult {
  deleted: number;
  failed: number;
}

/**
 * Every object under `prefix`, paging through ListObjectsV2. Throws when a
 * page cannot be read (AccessDenied without `s3:ListBucket`, network): a
 * partial listing is never returned, so a caller never acts on half a bucket.
 */
export async function listAvatarObjects(prefix: string, signal?: AbortSignal): Promise<AvatarObject[]> {
  const objects: AvatarObject[] = [];
  let continuationToken: string | undefined;
  do {
    if (signal?.aborted) {
      throw new Error('Avatar listing aborted');
    }
    const page = await s3Client.send(
      new ListObjectsV2Command({ Bucket: BUCKET_NAME, Prefix: prefix, ContinuationToken: continuationToken })
    );
    for (const item of page.Contents ?? []) {
      if (item.Key) {
        objects.push({ key: item.Key, lastModified: item.LastModified });
      }
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return objects;
}

/** True when `key` has the exact shape `avatars/<id>/<file>`. */
export function isIssuedAvatarKey(key: string): boolean {
  return ISSUED_KEY.test(key);
}

/**
 * Every object key a stored `profilePictureUrl` could be pointing at.
 *
 * Deliberately over-inclusive, because a miss deletes a photo that is in use
 * and the bucket is unversioned: the host is ignored (a regional or path-style
 * URL to our bucket still protects its object), and both the raw and the
 * percent-decoded path are taken from the first `avatars/` segment on.
 * Protecting a key that does not exist costs nothing.
 */
export function referencedAvatarKeys(storedUrl: string): string[] {
  const paths = new Set<string>();
  let pathname: string;
  try {
    pathname = new URL(storedUrl).pathname;
  } catch {
    // Unparsable: fall back to the raw string, minus any query or fragment.
    pathname = storedUrl.split(/[?#]/)[0];
  }
  paths.add(pathname);
  try {
    paths.add(decodeURIComponent(pathname));
  } catch {
    // Malformed escape: the raw form is already in the set.
  }

  const keys: string[] = [];
  for (const path of paths) {
    const at = path.indexOf('avatars/');
    if (at !== -1) {
      keys.push(path.slice(at));
    }
  }
  return keys;
}

/**
 * The set of object keys referenced by any `User.profilePictureUrl`, tombstones
 * and every row included. Throws on a database error, so a caller can never
 * mistake "could not read references" for "nothing is referenced".
 */
export async function loadReferencedAvatarKeys(): Promise<Set<string>> {
  const rows = await prisma.user.findMany({
    where: { profilePictureUrl: { not: null } },
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
 * Delete `keys` in batches of 1000. A failed batch or a per-key error is
 * counted and logged (no keys in the line), never thrown.
 */
export async function deleteAvatarKeys(keys: string[], signal?: AbortSignal): Promise<AvatarDeleteResult> {
  const result: AvatarDeleteResult = { deleted: 0, failed: 0 };
  for (let i = 0; i < keys.length; i += DELETE_BATCH_SIZE) {
    if (signal?.aborted) {
      break;
    }
    const batch = keys.slice(i, i + DELETE_BATCH_SIZE);
    try {
      const response = await s3Client.send(
        new DeleteObjectsCommand({
          Bucket: BUCKET_NAME,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        })
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
      result.failed += batch.length;
      logger.warn('Avatar batch delete failed', {
        operation: 'DeleteObjects',
        failed: batch.length,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

/**
 * After account deletion: delete every object under `avatars/<userId>/` that
 * no `User.profilePictureUrl` still references (#957). A coach or guardian
 * uploads a player's photo under their OWN prefix and writes it onto the
 * player's row, so the prefix can hold photos in use elsewhere; those stay.
 *
 * Best-effort, like `deletePreviousAvatar`: the account is already gone, so a
 * failure is logged and the function resolves. When either the listing or the
 * reference query fails, nothing is deleted.
 */
export async function deleteUnreferencedUserUploads(userId: string): Promise<void> {
  // The id becomes an S3 prefix; never let an odd value widen it.
  if (!/^[A-Za-z0-9_-]+$/.test(userId)) {
    logger.warn('Account upload cleanup skipped: user id is not a safe key segment');
    return;
  }

  try {
    const objects = await listAvatarObjects(`avatars/${userId}/`);
    const candidates = objects.map((o) => o.key).filter(isIssuedAvatarKey);
    if (candidates.length === 0) {
      return;
    }
    // Read references AFTER listing, so they are at least as fresh as the list.
    const referenced = await loadReferencedAvatarKeys();
    const orphans = candidates.filter((key) => !referenced.has(key));
    const { deleted, failed } = await deleteAvatarKeys(orphans);
    logger.info('Account avatar uploads cleaned up', {
      userId,
      listed: candidates.length,
      kept: candidates.length - orphans.length,
      deleted,
      failed,
    });
  } catch (err) {
    logger.warn('Account avatar upload cleanup failed (ignored)', {
      userId,
      operation: 'ListObjectsV2/references',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
