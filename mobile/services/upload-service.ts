import { File } from 'expo-file-system';
import { apiClient } from './api-client';
import { captureException } from './sentry';

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
 * 1. Opens the local file to learn its size (rejects unreadable and oversize files locally)
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

  const file = new File(localUri);
  if (!file.exists || file.size < 1) {
    throw new Error('The selected image could not be read');
  }
  if (file.size > MAX_AVATAR_BYTES) {
    throw new Error('Avatar image must be 5 MB or smaller');
  }

  // Get presigned POST from backend
  const { data } = await apiClient.post<AvatarUploadResponse>('/uploads/avatar-url', {
    contentType,
    contentLength: file.size,
  });

  // Build the multipart form: policy fields first, file part last (S3 requires it).
  const form = new FormData();
  for (const [name, value] of Object.entries(data.fields)) {
    form.append(name, value);
  }
  // The file part is an expo-file-system `File`. Since Expo SDK 57 the global
  // `fetch` is Expo's own, which encodes the multipart body in JavaScript and
  // takes a string, a Blob or a File for each part. React Native's
  // `{ uri, name, type }` part is refused there with "Unsupported FormDataPart
  // implementation" (#576).
  form.append('file', file);

  const res = await fetch(data.uploadUrl, { method: 'POST', body: form });
  if (!res.ok) {
    // S3 explains policy failures in an XML body (<Code>, <Message>). Surface
    // it so a failed upload is diagnosable from Sentry instead of a bare alert.
    const body = typeof res.text === 'function' ? await res.text().catch(() => '') : '';
    const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1];
    const detail = /<Message>([^<]+)<\/Message>/.exec(body)?.[1];
    const error = new Error(
      `Avatar upload failed (${res.status}${code ? ` ${code}` : ''}${detail ? `: ${detail}` : ''})`
    );
    captureException(error, {
      flow: 'avatar-upload',
      status: String(res.status),
      code: code ?? 'unknown',
      contentType,
      size: String(file.size),
    });
    throw error;
  }

  return data.imageUrl;
}
