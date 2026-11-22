/**
 * Team join link routes by token (#210).
 *
 *   GET  /api/v1/join/:token   public preview: team name + link state only
 *   POST /api/v1/join/:token   authenticated: ask to join (self or a child)
 *
 * The token is a bearer secret shared with a whole team, so it grants only
 * the right to ASK: a roster manager approves each request
 * (`/teams/:teamId/join-requests`, in the teams router). The link is managed
 * under `/teams/:teamId/join-link`.
 */

import { Router } from 'express';
import { JoinLinkService } from '../../services/join-link-service';
import { authenticate } from '../auth/middleware';
import { BadRequestError } from '../../utils/errors';
import { respondWithError } from '../../utils/respond-with-error';
import { logger } from '../../utils/logger';
import { isValidInvitationTokenFormat } from '../../utils/invitation-token';
import { joinLinkLookupIpRateLimit, joinRequestRateLimit } from '../middleware/rate-limit';
import { joinRequestSchema } from './schemas';

const router = Router();

/** Every 404 on this surface reads the same: unknown and revoked links are not told apart. */
const JOIN_LINK_NOT_FOUND = 'Join link not found';

/**
 * GET /api/v1/join/:token
 * Public preview for the web page and the app's deep-link screen:
 * `{ teamName, state }` with `state` one of `active`, `expired`, `full`.
 * No roster, no coach, no counts. A revoked link is a 404.
 *
 * Like the invitation lookup it is exempt from the global IP limit (the web
 * page fetches it server-side from one egress IP) and has a loose per-IP
 * ceiling of its own. No per-token budget: the link is shared with a whole
 * team, and one holder must not be able to spend it for everyone.
 *
 * A successful lookup logs `Join link viewed` (link id, state, client), never
 * the token or the team's name.
 */
router.get('/:token', joinLinkLookupIpRateLimit, async (req, res) => {
  const { token } = req.params;
  if (!isValidInvitationTokenFormat(token as string)) {
    res.status(400).json({ error: 'Invalid token format' });
    return;
  }

  try {
    const { linkId, ...preview } = await JoinLinkService.previewByToken(token as string);
    logger.info('Join link viewed', {
      linkId,
      state: preview.state,
      client: req.hooplingsClient ?? 'unknown',
    });
    res.json({ success: true, link: preview });
  } catch (error) {
    respondWithError(res, error, {
      log: 'Error fetching join link',
      fallback: 'Failed to fetch join link',
      notFound: JOIN_LINK_NOT_FOUND,
    });
  }
});

/**
 * POST /api/v1/join/:token
 * The signed-in account asks to join the link's team. Body:
 * `{ kind: 'self' }` or `{ kind: 'child', childName, relationship }`.
 *
 * 201 `{ status: 'pending', created: true, … }` for a new request; 200 for a
 * request that already existed or `{ status: 'already_member' }` (nothing
 * written), whatever has happened to the link since. A new request needs a
 * live link: 404 unknown or revoked, 410 `join_link_inactive` (expired or
 * full). The roster is not touched until a coach approves.
 */
router.post('/:token', authenticate, joinRequestRateLimit, async (req, res) => {
  const { token } = req.params;
  if (!isValidInvitationTokenFormat(token as string)) {
    res.status(400).json({ error: 'Invalid token format' });
    return;
  }

  try {
    const validationResult = joinRequestSchema.safeParse(req.body);
    if (!validationResult.success) {
      throw new BadRequestError(
        validationResult.error.issues.map((e: { message: string }) => e.message).join(', ')
      );
    }

    const result = await JoinLinkService.requestToJoin(token as string, validationResult.data, req.user!.id);
    const created = result.status === 'pending' && result.created;
    res.status(created ? 201 : 200).json({ success: true, ...result });
  } catch (error) {
    respondWithError(res, error, {
      log: 'Error requesting to join team',
      fallback: 'Failed to send join request',
      notFound: JOIN_LINK_NOT_FOUND,
    });
  }
});

export default router;
