import { apiClient } from './api-client';

interface AvatarUploadResponse {
  uploadUrl: string;
  fields: Record<string, string>;
  imageUrl: string;
}

/** Mirrors the backend's MAX_AVATAR_BYTES (S3 POST policy cap). */
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

/**
 * Upload an avatar image to S3 via a presigned POST policy.
 *
 * 1. Reads the local file to learn its size (rejects oversize files locally)
 * 2. Requests a presigned POST (url + policy fields) from the backend
 * 3. POSTs a multipart form (policy fields + `file`) directly to S3
 * 4. Returns the public image URL
 *
 * Throws if any step fails — in particular if S3 rejects the upload — so the
 * caller never persists a URL that points at nothing.
 */
export async function uploadAvatar(localUri: string): Promise<string> {
  const isPng = localUri.toLowerCase().endsWith('.png');
  const contentType = isPng ? 'image/png' : 'image/jpeg';

  // Read the local file as a blob (for its size)
  const response = await fetch(localUri);
  const blob = await response.blob();
  if (blob.size > MAX_AVATAR_BYTES) {
    throw new Error('Avatar image must be 5 MB or smaller');
  }

  // Get presigned POST from backend
  const { data } = await apiClient.post<AvatarUploadResponse>('/uploads/avatar-url', {
    contentType,
    contentLength: blob.size,
  });

  // Build the multipart form: policy fields first, file part last (S3 requires it).
  const form = new FormData();
  for (const [name, value] of Object.entries(data.fields)) {
    form.append(name, value);
  }
  // React Native's FormData uploads `{ uri, name, type }` objects natively.
  form.append('file', {
    uri: localUri,
    name: `avatar.${isPng ? 'png' : 'jpg'}`,
    type: contentType,
  } as unknown as Blob);

  const res = await fetch(data.uploadUrl, { method: 'POST', body: form });
  if (!res.ok) {
    throw new Error(`Avatar upload failed (${res.status})`);
  }

  return data.imageUrl;
}
