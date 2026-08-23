import { Router } from 'express';
import { authenticate } from '../auth/middleware';
import { avatarUploadUrlSchema } from './schemas';
import { generateAvatarUploadUrl } from '../../services/upload-service';
import { BadRequestError } from '../../utils/errors';
import { logger } from '../../utils/logger';

const router = Router();

router.use(authenticate);

/**
 * POST /api/v1/uploads/avatar-url
 * Generate a presigned S3 POST (url + form fields) for an avatar upload.
 * The policy caps the object at MAX_AVATAR_BYTES and pins the content type.
 */
router.post('/avatar-url', async (req, res) => {
  try {
    const validationResult = avatarUploadUrlSchema.safeParse(req.body);
    if (!validationResult.success) {
      throw new BadRequestError(
        validationResult.error.issues.map((e: { message: string }) => e.message).join(', ')
      );
    }

    const { contentType, contentLength } = validationResult.data;
    const userId = req.user!.id;

    const result = await generateAvatarUploadUrl(userId, contentType, contentLength);
    res.json(result);
  } catch (error) {
    if (error instanceof BadRequestError) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      logger.error('Error generating avatar upload URL', { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: 'Failed to generate upload URL' });
    }
  }
});

export default router;
