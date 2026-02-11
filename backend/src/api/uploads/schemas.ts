import { z } from 'zod';

export const avatarUploadUrlSchema = z.object({
  contentType: z.enum(['image/jpeg', 'image/png']),
});
