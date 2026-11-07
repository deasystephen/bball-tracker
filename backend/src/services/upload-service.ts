import {
  S3Client,
  DeleteObjectCommand,
  DeleteObjectTaggingCommand,
  HeadBucketCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
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
 * Once `AVATAR_PENDING_TAG_ENABLED` is on, every upload is born tagged
 * `pending=true` (#1005). The profile write that stores its URL removes the
 * tag after it commits (`withPromotedAvatar`); the bucket's lifecycle rule
 * (`infra/s3.tf`, `expire-pending-avatars`) deletes whatever is still pending
 * 3 days after upload. Tag key and value must match that rule.
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
 * Whether new uploads are born `pending=true` (#1005). Off unless
 * `AVATAR_PENDING_TAG_ENABLED=true`. The check before a save and the untag
 * after it run regardless (untagging an untagged object is harmless), so the
 * rollout is: apply the IAM and lifecycle rule, deploy the code (saves untag,
 * nothing is tagged yet), then set the flag. Rolling the flag back lands on
 * code that still untags.
 */
export function pendingTagEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AVATAR_PENDING_TAG_ENABLED?.trim().toLowerCase() === 'true';
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
    // `tagging` carries the pending tag set (#1005), once AVATAR_PENDING_TAG_ENABLED
    // is on (`pendingTagEnabled`). The SDK pins every entry
    // of `Fields` in the signed policy as an exact match ({ tagging: … }), so a
    // client cannot drop or change the tag and keep an unsaved upload forever
    // (avatar-upload-policy.test.ts decodes the real policy to prove it).
    // Every binary posts every field it is given: no client change is needed.
    Conditions: [
      ['content-length-range', 1, MAX_AVATAR_BYTES],
      ['eq', '$Content-Type', contentType],
    ],
    Fields: {
      'Content-Type': contentType,
      ...(pendingTagEnabled() && { tagging: PENDING_TAGGING_XML }),
    },
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
 * never on the raw string: the object key comes from `URL.pathname`
 * (`issuedAvatarKey`), which collapses `..` and `%2e%2e` segments, so a raw
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
 * `deleteAvatarObject`, `discardOwnAvatar` and the #1005 check and untag.
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

function httpStatus(err: unknown): unknown {
  return (err as { $metadata?: { httpStatusCode?: unknown } } | null)?.$metadata?.httpStatusCode;
}

/** A 404 from S3 (`NoSuchKey`, or HEAD's bodiless `NotFound`), never `NoSuchBucket`. */
function isNotFound(err: unknown): boolean {
  const code = s3ErrorCode(err);
  if (code === 'NoSuchBucket') return false;
  return code === 'NoSuchKey' || code === 'NotFound' || httpStatus(err) === 404;
}

/**
 * Only the `AccessDenied` error code. Other 403s (a bad signature, clock skew,
 * expired credentials, KMS) are faults. A HEAD response has no body, so a 403
 * on HeadObject arrives as `Forbidden` and is never this.
 */
function isAccessDeniedCode(err: unknown): boolean {
  return s3ErrorCode(err) === 'AccessDenied';
}

function faultFields(err: unknown): { code: string | undefined; error: string } {
  return { code: s3ErrorCode(err), error: err instanceof Error ? err.message : String(err) };
}

/**
 * Step A, before the write (#1005): `HeadObject` on the validated key of an
 * upload in our bucket. Returns the key to untag after the commit, or `null`
 * for nothing to do (an external URL, such as a WorkOS photo, or an empty
 * value). Nothing is untagged here.
 *
 * - 404: a HEAD 404 cannot tell a missing key from a missing bucket, so one
 *   `HeadBucket` settles it. Bucket there: the upload is gone (it expired),
 *   `UploadExpiredError` (400 `upload_expired`), nothing written. Bucket
 *   missing or unreadable: a configuration fault, 5xx with Sentry.
 * - Error code `AccessDenied` while `AVATAR_PENDING_TAG_ENABLED` is off:
 *   logged at warn and the save proceeds (nothing is tagged then).
 * - Anything else, including every other 403: logged at error, captured to
 *   Sentry (`flow: avatar-promote`) and rethrown, a 5xx.
 */
export async function checkAvatarUpload(imageUrl: string | null | undefined): Promise<string | null> {
  const issued = issuedAvatarKey(imageUrl);
  if ('reason' in issued) {
    if (issued.reason === 'not_managed') {
      return null;
    }
    // `assertOwnUploadUrl` has already refused this shape on every write path.
    throw new BadRequestError('profilePictureUrl must be an upload issued to the caller');
  }

  let failure: unknown;
  let operation = 'HeadObject';
  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: issued.key }));
    return issued.key;
  } catch (err) {
    failure = err;
  }

  if (isNotFound(failure)) {
    try {
      await s3Client.send(new HeadBucketCommand({ Bucket: BUCKET_NAME }));
    } catch (err) {
      failure = err;
      operation = 'HeadBucket';
    }
    if (operation === 'HeadObject') {
      throw new UploadExpiredError();
    }
  } else if (isAccessDeniedCode(failure) && !pendingTagEnabled()) {
    logger.warn('Avatar upload check denied; saving anyway (pending tagging is off)', {
      operation,
      key: issued.key,
    });
    return issued.key;
  }

  logger.error('Avatar upload check failed', { operation, key: issued.key, ...faultFields(failure) });
  captureException(failure, { flow: 'avatar-promote' });
  throw failure;
}

/**
 * Step C, only AFTER the write committed (#1005): remove the `pending` tag so
 * the lifecycle rule never expires the saved photo. One call; the S3 client's
 * own retries cover transient failures. Never throws: the request already
 * succeeded.
 *
 * - Failing: logged at error with the key and captured to Sentry
 *   (`flow: avatar-promote`); an operator removes the tag by hand
 *   (`docs/runbooks/data-subject-requests.md`), or the photo expires.
 * - Missing (it expired between the check and now, which takes a 3-day-old
 *   upload): logged at error.
 * - Error code `AccessDenied` while the flag is off: logged at warn (nothing
 *   is tagged then).
 */
export async function untagAvatarUpload(key: string): Promise<void> {
  try {
    await s3Client.send(new DeleteObjectTaggingCommand({ Bucket: BUCKET_NAME, Key: key }));
  } catch (err) {
    if (isNotFound(err)) {
      logger.error('Saved avatar upload expired before it was untagged', { operation: 'DeleteObjectTagging', key });
      return;
    }
    if (isAccessDeniedCode(err) && !pendingTagEnabled()) {
      logger.warn('Avatar untag denied (pending tagging is off; nothing to untag)', {
        operation: 'DeleteObjectTagging',
        key,
      });
      return;
    }
    logger.error('Could not untag a saved avatar upload; it will expire unless untagged by hand', {
      operation: 'DeleteObjectTagging',
      key,
      ...faultFields(err),
    });
    captureException(err, { flow: 'avatar-promote' });
  }
}

/**
 * Save a `profilePictureUrl` in the order that leaves nothing to undo (#1005):
 * A. `checkAvatarUpload` (HeadObject; 400 `upload_expired` when it is gone),
 * B. `write`, the database work that stores it,
 * C. `untagAvatarUpload`, only after `write` resolved (committed).
 * A failed write touches S3 no further, and neither does a committed write
 * that did not keep the URL (`stored` returns false): the upload stays as it
 * was (pending, once tagging is enabled) and the lifecycle rule expires it. So a double
 * submit is safe: whichever request commits untags afterwards, and the one
 * that fails changes nothing.
 */
export async function withPromotedAvatar<T>(
  imageUrl: string | null | undefined,
  write: () => Promise<T>,
  stored: (result: T) => boolean = () => true
): Promise<T> {
  const key = await checkAvatarUpload(imageUrl);
  const result = await write();
  // `stored` says whether the committed write actually kept the URL (Add
  // Player case 2 may keep a reused row's own photo): if not, the upload is
  // left as it was, for the lifecycle rule.
  if (key !== null && stored(result)) {
    await untagAvatarUpload(key);
  }
  return result;
}
