/**
 * System-ADMIN routes (`/api/v1/admin/*`).
 *
 * Operator actions that have no place in the product UI. Every route here is
 * for `role === 'ADMIN'` only; the service re-checks, the route never trusts
 * a client-supplied role.
 */

import { Router } from 'express';
import { authenticate } from '../auth/middleware';
import { validateUuidParams } from '../middleware/validate-params';
import { SubscriptionService } from '../../services/subscription-service';
import { BadRequestError } from '../../utils/errors';
import { setSubscriptionSchema } from './schemas';

const router = Router();

router.use(authenticate);

/**
 * PATCH /api/v1/admin/users/:userId/subscription
 * Set an account's subscription tier and expiry (#445) — the way to comp an
 * account while there is no purchase flow.
 *
 * Body: `{ tier: 'FREE' | 'PREMIUM' | 'LEAGUE', expiresAt?: string | null }`
 * (`expiresAt` ISO 8601; required and in the future for PREMIUM / LEAGUE,
 * omitted or null for FREE).
 *
 * - 200 `{ success, user: { id, name, email, role, subscriptionTier,
 *   subscriptionExpiresAt }, effectiveTier }`
 * - 400 invalid body or `userId`, or the account has been deleted
 * - 403 caller is not a system ADMIN
 * - 404 no such user
 */
router.patch('/users/:userId/subscription', validateUuidParams('userId'), async (req, res, next) => {
  try {
    const parsed = setSubscriptionSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequestError(
        parsed.error.issues.map((e: { message: string }) => e.message).join(', ')
      );
    }

    const result = await SubscriptionService.setSubscription(
      req.params.userId as string,
      parsed.data,
      { id: req.user!.id, role: req.user!.role }
    );

    res.json({ success: true, user: result.user, effectiveTier: result.effectiveTier });
  } catch (error) {
    // The central handler in `index.ts` serializes AppErrors and logs the rest.
    next(error);
  }
});

export default router;
