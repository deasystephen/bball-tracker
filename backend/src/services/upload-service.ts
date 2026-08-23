import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { randomUUID } from 'crypto';
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
 */
export async function deletePreviousAvatar(
  previousUrl: string | null | undefined,
  nextUrl: string | null | undefined
): Promise<void> {
  if (!isManagedAvatarUrl(previousUrl) || previousUrl === nextUrl) {
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
