/**
 * Zod schemas for the system-ADMIN routes (`/api/v1/admin/*`).
 */

import { z } from 'zod';
import { SubscriptionTier } from '@prisma/client';

/** Every tier an account can be put on — the Prisma enum, never a copy of it. */
export const SUBSCRIPTION_TIERS = Object.values(SubscriptionTier) as [
  SubscriptionTier,
  ...SubscriptionTier[],
];

/**
 * Body of `PATCH /admin/users/:userId/subscription` (#445).
 *
 * `expiresAt` is optional and nullable, but what it may hold depends on the
 * tier, because of how `isSubscriptionActive` reads the pair:
 *
 * - PREMIUM / LEAGUE need an `expiresAt` in the future. A paid tier with no
 *   expiry (or a past one) resolves to an effective FREE tier, so accepting it
 *   would store a comp that silently does nothing.
 * - FREE takes no expiry: omit it or send `null`. The stored value is cleared.
 */
export const setSubscriptionSchema = z
  .object({
    tier: z.enum(SUBSCRIPTION_TIERS, {
      message: `Tier must be one of ${SUBSCRIPTION_TIERS.join(', ')}`,
    }),
    expiresAt: z
      .string()
      .datetime({ offset: true, message: 'expiresAt must be an ISO 8601 date-time' })
      .nullable()
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (data.tier === 'FREE') {
      if (data.expiresAt != null) {
        ctx.addIssue({
          code: 'custom',
          path: ['expiresAt'],
          message: 'expiresAt must be omitted or null for the FREE tier',
        });
      }
      return;
    }
    if (data.expiresAt == null) {
      ctx.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: `expiresAt is required for ${data.tier}: a paid tier without an expiry resolves to FREE`,
      });
      return;
    }
    // Zod runs this refinement even when `expiresAt` already failed its own
    // check, so the value may be anything here. A malformed one has its issue
    // already; only compare a value that really is a date-time.
    const expiresAtMs = typeof data.expiresAt === 'string' ? Date.parse(data.expiresAt) : NaN;
    if (!Number.isNaN(expiresAtMs) && expiresAtMs <= Date.now()) {
      ctx.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'expiresAt must be in the future',
      });
    }
  })
  .transform((data) => ({
    tier: data.tier,
    expiresAt: data.expiresAt == null ? null : new Date(data.expiresAt),
  }));

export type SetSubscriptionInput = z.infer<typeof setSubscriptionSchema>;
