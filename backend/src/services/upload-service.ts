import { S3Client, DeleteObjectCommand, DeleteObjectTaggingCommand, PutObjectTaggingCommand } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { randomUUID } from 'crypto';
import { BadRequestError, UploadExpiredError } from '../utils/errors';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';

const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
});

const BUCKET_NAME = process.env.S3_AVATARS_BUCKET || 'bball-tracker-avatars-dev';
const BUCKET_URL_PREFIX = `https://${BUCKET_NAME}.s3.amazonaws.com/avatars/`;

/** Hard cap on avatar size, enforced by the S3 POST policy (audit #61). */
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

/** Presigned upload validity (seconds). */
const UPLOAD_EXPIRES_SECONDS = 300;

/**
 * Every upload is born tagged `pending=true` (#1005). The profile write that
 * stores its URL removes the tag (`promoteAvatarUpload`); the bucket's
 * lifecycle rule (`infra/s3.tf`, `expire-pending-avatars`) deletes whatever is
 * still pending 3 days after upload. Tag key and value must match that rule.
 */
export const PENDING_TAG_KEY = 'pending';
export const PENDING_TAG_VALUE = 'true';
/** The S3 POST `tagging` form field: the tag set as XML. */
export const PENDING_TAGGING_XML = `<Tagging><TagSet><Tag><Key>${PENDING_TAG_KEY}</Key><Value>${PENDING_TAG_VALUE}</Value></Tag></TagSet></Tagging>`;

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
    // `tagging` carries the pending tag set (#1005). The SDK pins every entry
    // of `Fields` in the signed policy as an exact match ({ tagging: … }), so a
    // client cannot drop or change the tag and keep an unsaved upload forever
    // (avatar-upload-policy.test.ts decodes the real policy to prove it).
    // Every binary posts every field it is given: no client change is needed.
    Conditions: [
      ['content-length-range', 1, MAX_AVATAR_BYTES],
      ['eq', '$Content-Type', contentType],
    ],
    Fields: { 'Content-Type': contentType, tagging: PENDING_TAGGING_XML },
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
  await deleteObjectByKey(key);
}

/** Delete one object of the avatars bucket by key. Throws on an S3 error. */
async function deleteObjectByKey(key: string): Promise<void> {
  await s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
}

/** What happened to an avatar object a caller asked to remove. */
export type AvatarDeletion = 'deleted' | 'failed' | 'not_ours';

/**
 * The object key a stored or submitted URL names, when it is one of ours and
 * has the exact issued shape `/avatars/<id>/<file>` on the PARSED path, or why
 * not. The one place that turns a URL into a key we may act on: shared by
 * `deleteAvatarObject` and `promoteAvatarUpload` (#1005).
 */
type IssuedAvatarKey =
  | { key: string }
  | { reason: 'not_managed' | 'unparsable' | 'path outside avatars/<id>/<file>' };

function issuedAvatarKey(imageUrl: string | null | undefined): IssuedAvatarKey {
  if (!isManagedAvatarUrl(imageUrl)) {
    return { reason: 'not_managed' };
  }
  const path = parsedPath(imageUrl);
  if (path === null) {
    return { reason: 'unparsable' };
  }
  if (!ISSUED_KEY_PATH.test(path)) {
    return { reason: 'path outside avatars/<id>/<file>' };
  }
  return { key: path.slice(1) };
}

/**
 * Throws unless the avatar bucket is configured explicitly. Without
 * `S3_AVATARS_BUCKET` the module falls back to the dev bucket, so production
 * avatar URLs would not be recognised as ours and nothing would be deleted.
 * Operator scripts that delete avatars call this before writing anything.
 */
export function assertAvatarStorageConfig(env: NodeJS.ProcessEnv = process.env): void {
  if (!env.S3_AVATARS_BUCKET) {
    throw new Error('S3_AVATARS_BUCKET is not set: avatar objects cannot be deleted');
  }
}

/**
 * Removes one avatar object and says what happened: `not_ours` for a URL
 * outside our bucket (a WorkOS profile photo, say) or one whose parsed path
 * is not an issued upload key, `failed` when S3 refused (logged at warn,
 * never thrown), `deleted` otherwise.
 *
 * Defence in depth behind `assertOwnUploadUrl` (#717): the stored URL may
 * predate the write-time gate, so the delete is refused unless the parsed
 * path has the exact issued shape `/avatars/<id>/<file>`. A URL whose `..`
 * segments would collapse the key outside `avatars/` (or into a different
 * shape) deletes nothing and leaves a warning. No owner id is checked here:
 * the row's owner is not always the uploader (coach-uploaded player photos),
 * which is why the gate sits at write time.
 */
export async function deleteAvatarObject(imageUrl: string | null | undefined): Promise<AvatarDeletion> {
  const issued = issuedAvatarKey(imageUrl);
  if ('reason' in issued) {
    if (issued.reason !== 'not_managed') {
      // Never the URL itself: it is client-supplied and this is the hostile case.
      logger.warn('Avatar URL is not an issued upload key; not deleted', { reason: issued.reason });
    }
    return 'not_ours';
  }

  try {
    await deleteObjectByKey(issued.key);
    return 'deleted';
  } catch (err) {
    logger.warn('Failed to delete avatar object', {
      // The validated key (ids only), never the client-supplied URL.
      key: issued.key,
      error: err instanceof Error ? err.message : String(err),
    });
    return 'failed';
  }
}

/**
 * Best-effort removal of the avatar object that `nextUrl` replaces, so every
 * avatar change doesn't leave the previous object orphaned in S3 (audit #61).
 * Only objects in our bucket are touched (`deleteAvatarObject`); failures are
 * logged, never thrown — the profile update has already succeeded.
 */
export async function deletePreviousAvatar(
  previousUrl: string | null | undefined,
  nextUrl: string | null | undefined
): Promise<void> {
  if (previousUrl === nextUrl) {
    return;
  }
  await deleteAvatarObject(previousUrl);
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
  const issued = issuedAvatarKey(imageUrl);
  if ('reason' in issued || !isOwnUploadUrl(imageUrl, userId)) {
    return;
  }

  try {
    await deleteObjectByKey(issued.key);
  } catch (err) {
    logger.warn('Failed to discard unreferenced avatar object (ignored)', {
      // The validated key (ids only), never the client-supplied URL.
      key: issued.key,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** The S3 error code of an SDK rejection (`name`, or `Code` on some shapes). */
function s3ErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as { name?: unknown; Code?: unknown };
  if (typeof e.Code === 'string') return e.Code;
  return typeof e.name === 'string' ? e.name : undefined;
}

/**
 * Mark an upload as saved: remove its `pending` tag so the lifecycle rule
 * never expires it (#1005). Callers go through `withPromotedAvatar`, which
 * runs this after `assertOwnUploadUrl` and BEFORE the database write.
 * Returns `true` when an object of ours was promoted, `false` for nothing to
 * do (an external URL, such as a WorkOS photo, or an empty value).
 *
 * - `NoSuchKey` (the lifecycle expired it): throws `UploadExpiredError`
 *   (400 `upload_expired`), so a dead URL is never stored. Only that code:
 *   S3 answers a missing key with `NoSuchKey` only when the role may list the
 *   bucket (`s3:ListBucket`, `infra/ecs.tf`); without it, it is a 403.
 * - Anything else (`AccessDenied`, `NoSuchBucket`, network, throttling) is a
 *   fault, not the user's: logged at error, captured to Sentry and rethrown,
 *   so the route answers 5xx and writes nothing. There is no fail-open: the
 *   upload itself needs the tagging grant, so the IAM apply always precedes
 *   the deploy, and storing a URL that silently expires in 3 days is worse
 *   than a failed save.
 */
export async function promoteAvatarUpload(imageUrl: string | null | undefined): Promise<boolean> {
  const issued = issuedAvatarKey(imageUrl);
  if ('reason' in issued) {
    if (issued.reason === 'not_managed') {
      return false;
    }
    // `assertOwnUploadUrl` has already refused this shape on every write path.
    throw new BadRequestError('profilePictureUrl must be an upload issued to the caller');
  }

  try {
    await s3Client.send(new DeleteObjectTaggingCommand({ Bucket: BUCKET_NAME, Key: issued.key }));
    return true;
  } catch (err) {
    if (s3ErrorCode(err) === 'NoSuchKey') {
      throw new UploadExpiredError();
    }
    logger.error('Avatar promotion failed', {
      operation: 'DeleteObjectTagging',
      key: issued.key,
      code: s3ErrorCode(err),
      error: err instanceof Error ? err.message : String(err),
    });
    captureException(err, { flow: 'avatar-promote' });
    throw err;
  }
}

/**
 * Put an upload back in the pending state (`pending=true`), so the lifecycle
 * rule expires it in 3 days unless a later save promotes it again (#1005).
 * Used when a promoted upload ends up stored nowhere: the write failed, or
 * Add Player kept the row's own photo. Reverting instead of deleting carries
 * no deletion hazard: if the URL is in fact stored somewhere (a write that
 * committed and then threw, another row naming the same upload) it stays
 * readable until a save promotes it again, and a client retry still works.
 * Never throws: a failure is logged at error and captured, and nothing is
 * deleted.
 */
export async function revertAvatarToPending(imageUrl: string | null | undefined): Promise<void> {
  const issued = issuedAvatarKey(imageUrl);
  if ('reason' in issued) {
    return;
  }
  try {
    await s3Client.send(
      new PutObjectTaggingCommand({
        Bucket: BUCKET_NAME,
        Key: issued.key,
        Tagging: { TagSet: [{ Key: PENDING_TAG_KEY, Value: PENDING_TAG_VALUE }] },
      })
    );
  } catch (err) {
    logger.error('Could not revert avatar upload to pending', {
      operation: 'PutObjectTagging',
      key: issued.key,
      code: s3ErrorCode(err),
      error: err instanceof Error ? err.message : String(err),
    });
    captureException(err, { flow: 'avatar-revert' });
  }
}

/**
 * Promote `imageUrl` (see `promoteAvatarUpload`), run `write`, the database
 * work that stores it, and REVERT the upload TO PENDING (`revertAvatarToPending`)
 * when `write` throws: P2002, P2025 on a tombstone, a refused transaction…
 * The lifecycle rule then expires it; nothing is deleted here. The one place
 * every write site promotes and reverts.
 */
export async function withPromotedAvatar<T>(imageUrl: string | null | undefined, write: () => Promise<T>): Promise<T> {
  const promoted = await promoteAvatarUpload(imageUrl);
  try {
    return await write();
  } catch (err) {
    if (promoted) {
      await revertAvatarToPending(imageUrl);
    }
    throw err;
  }
}
