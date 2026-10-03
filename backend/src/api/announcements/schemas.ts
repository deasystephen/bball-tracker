import { z } from 'zod';

/**
 * Body of POST /announcements/:id/replies (#34). Plain text only; rich text
 * and attachments are out of scope.
 */
export const createReplySchema = z.object({
  body: z.string().trim().min(1, 'Reply is required').max(2000, 'Reply too long'),
});

/**
 * Query of GET /announcements/:id/replies. Same bounds as the announcement
 * list: 20 per page by default, at most 100.
 */
export const replyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export type CreateReplyInput = z.infer<typeof createReplySchema>;
export type ReplyQueryParams = z.infer<typeof replyQuerySchema>;
