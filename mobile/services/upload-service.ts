import { apiClient } from './api-client';

interface AvatarUploadResponse {
  uploadUrl: string;
  imageUrl: string;
}

/**
 * Upload an avatar image to S3 via presigned URL.
 *
 * 1. Requests a presigned PUT URL from the backend
 * 2. Reads the local file as a blob
 * 3. PUTs the blob directly to S3
 * 4. Returns the public image URL
 */
export async function uploadAvatar(localUri: string): Promise<string> {
  const contentType = localUri.toLowerCase().endsWith('.png')
    ? 'image/png'
    : 'image/jpeg';

  // Get presigned URL from backend
  const { data } = await apiClient.post<AvatarUploadResponse>(
    '/uploads/avatar-url',
    { contentType }
  );

  // Read the local file as a blob
  const response = await fetch(localUri);
  const blob = await response.blob();

  // Upload directly to S3
  await fetch(data.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: blob,
  });

  return data.imageUrl;
}
