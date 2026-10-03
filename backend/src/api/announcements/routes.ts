/**
 * Announcement detail and threaded replies (#34).
 *
 * Announcements are created and listed under /teams/:teamId/announcements
 * (teams/routes.ts); this router owns the announcement-scoped routes. Every
 * route is authenticated; the services decide access (404 unknown, 403 no
 * team access).
 */

import { Router } from 'express';
import { authenticate } from '../auth/middleware';
import { validateUuidParams } from '../middleware/validate-params';
import { createReplySchema, replyQuerySchema } from './schemas';
import { AnnouncementService } from '../../services/announcement-service';
import { AnnouncementReplyService } from '../../services/announcement-reply-service';
import { AppError, BadRequestError } from '../../utils/errors';
import { logger } from '../../utils/logger';

const router = Router();

router.use(authenticate);

/**
 * GET /api/v1/announcements/:id
 * One announcement with its author and reply count.
 */
router.get('/:id', validateUuidParams('id'), async (req, res) => {
  try {
    const announcement = await AnnouncementService.getAnnouncement(req.params.id as string, req.user!.id);
    res.json({ success: true, announcement });
  } catch (error) {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    logger.error('Error loading announcement', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to load announcement' });
  }
});

/**
 * POST /api/v1/announcements/:id/replies
 * Reply to an announcement (anyone with access to its team).
 */
router.post('/:id/replies', validateUuidParams('id'), async (req, res) => {
  try {
    const parsed = createReplySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequestError(parsed.error.issues.map((e: { message: string }) => e.message).join(', '));
    }

    const reply = await AnnouncementReplyService.createReply(req.params.id as string, parsed.data, req.user!.id);
    res.status(201).json({ success: true, reply });
  } catch (error) {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    logger.error('Error creating announcement reply', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to create reply' });
  }
});

/**
 * GET /api/v1/announcements/:id/replies
 * The thread, oldest first, paginated.
 */
router.get('/:id/replies', validateUuidParams('id'), async (req, res) => {
  try {
    const parsed = replyQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new BadRequestError(parsed.error.issues.map((e: { message: string }) => e.message).join(', '));
    }

    const result = await AnnouncementReplyService.listReplies(req.params.id as string, req.user!.id, parsed.data);
    res.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    logger.error('Error listing announcement replies', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to list replies' });
  }
});

/**
 * DELETE /api/v1/announcements/:id/replies/:replyId
 * Remove a reply: its author, or a coach of the team.
 */
router.delete('/:id/replies/:replyId', validateUuidParams('id', 'replyId'), async (req, res) => {
  try {
    await AnnouncementReplyService.deleteReply(req.params.id as string, req.params.replyId as string, req.user!.id);
    res.status(204).send();
  } catch (error) {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    logger.error('Error deleting announcement reply', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to delete reply' });
  }
});

export default router;
