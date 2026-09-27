/**
 * Subscription administration (#445).
 *
 * There is no purchase flow yet (#41), so the ONLY way an account reaches
 * PREMIUM or LEAGUE is a system ADMIN setting it here — comping a design
 * partner or a friendly league. Before this existed the only option was
 * hand-written SQL against production.
 *
 * Tier RULES (what a tier unlocks, what it caps) stay in
 * `services/entitlements`; this service only writes the two columns those
 * rules read: `subscriptionTier` and `subscriptionExpiresAt`.
 */

import { Prisma, SubscriptionTier } from '@prisma/client';
import prisma from '../models';
import { logger } from '../utils/logger';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import { getEffectiveTier } from './entitlements';
import { invalidateUsage } from './usage-service';

/** What an admin gets back: enough to confirm the right account was changed. */
export const USER_SUBSCRIPTION_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  subscriptionTier: true,
  subscriptionExpiresAt: true,
} satisfies Prisma.UserSelect;

export type UserSubscription = Prisma.UserGetPayload<{
  select: typeof USER_SUBSCRIPTION_SELECT;
}>;

export interface SetSubscriptionResult {
  user: UserSubscription;
  /** The tier the entitlement layer will actually apply (expiry accounted for). */
  effectiveTier: SubscriptionTier;
}

/** The authenticated caller, as attached by the `authenticate` middleware. */
export interface SubscriptionActor {
  id: string;
  role: string;
}

export interface SetSubscriptionData {
  tier: SubscriptionTier;
  expiresAt: Date | null;
}

export class SubscriptionService {
  /**
   * Put `userId` on `tier` until `expiresAt`. System ADMIN only.
   *
   * - 403 when the actor is not a system ADMIN
   * - 404 when no such user exists
   * - 400 when the account has been deleted (#444): the write is conditioned
   *   on `deletedAt IS NULL`, like every other write onto a `User` row, so a
   *   deletion that commits between the read and the write still wins
   */
  static async setSubscription(
    userId: string,
    data: SetSubscriptionData,
    actor: SubscriptionActor
  ): Promise<SetSubscriptionResult> {
    if (actor.role !== 'ADMIN') {
      throw new ForbiddenError('Only system admins can change a subscription');
    }

    const before = await prisma.user.findUnique({
      where: { id: userId },
      select: { subscriptionTier: true, subscriptionExpiresAt: true, deletedAt: true },
    });
    if (!before) {
      throw new NotFoundError('User not found');
    }
    if (before.deletedAt) {
      throw new BadRequestError('Cannot change the subscription of a deleted account');
    }

    const updated = await prisma.user.updateMany({
      where: { id: userId, deletedAt: null },
      data: { subscriptionTier: data.tier, subscriptionExpiresAt: data.expiresAt },
    });
    if (updated.count === 0) {
      throw new BadRequestError('Cannot change the subscription of a deleted account');
    }

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: USER_SUBSCRIPTION_SELECT,
    });

    // Limits are derived from the tier at read time, but drop the cached
    // counts too so the very next `/auth/me/usage` is computed fresh.
    await invalidateUsage(userId);

    // The audit trail for a comp: who, for whom, from what, to what.
    logger.info('Subscription changed by admin', {
      actorId: actor.id,
      userId,
      fromTier: before.subscriptionTier,
      fromExpiresAt: before.subscriptionExpiresAt?.toISOString() ?? null,
      toTier: user.subscriptionTier,
      toExpiresAt: user.subscriptionExpiresAt?.toISOString() ?? null,
    });

    return { user, effectiveTier: getEffectiveTier(user) };
  }
}
