import { z } from 'zod';
import { MAX_AVATAR_BYTES } from '../../services/upload-service';

export const avatarUploadUrlSchema = z.object({
  contentType: z.enum(['image/jpeg', 'image/png']),
  // Optional early size check so the client gets a clean 400 before uploading;
  // the S3 POST policy enforces the same cap server-side regardless.
  contentLength: z
    .number()
    .int()
    .positive()
    .max(MAX_AVATAR_BYTES, `Avatar must be ${MAX_AVATAR_BYTES} bytes or smaller`)
    .optional(),
});
