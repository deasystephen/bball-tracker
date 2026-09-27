/**
 * Schema tests for PATCH /admin/users/:userId/subscription (#445)
 */

import { SubscriptionTier } from '@prisma/client';
import { setSubscriptionSchema, SUBSCRIPTION_TIERS } from '../../src/api/admin/schemas';

const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
const PAST = '2020-01-01T00:00:00.000Z';

function messages(input: unknown): string[] {
  const result = setSubscriptionSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

describe('setSubscriptionSchema', () => {
  it('offers exactly the tiers of the Prisma enum', () => {
    expect([...SUBSCRIPTION_TIERS].sort()).toEqual(Object.values(SubscriptionTier).sort());
  });

  describe('paid tiers', () => {
    it.each(['PREMIUM', 'LEAGUE'] as const)('accepts %s with a future expiry', (tier) => {
      const result = setSubscriptionSchema.safeParse({ tier, expiresAt: FUTURE });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ tier, expiresAt: new Date(FUTURE) });
    });

    it('accepts an expiry with a timezone offset', () => {
      const result = setSubscriptionSchema.safeParse({
        tier: 'PREMIUM',
        expiresAt: '2999-06-30T23:59:59+02:00',
      });

      expect(result.success).toBe(true);
      expect(result.data?.expiresAt?.toISOString()).toBe('2999-06-30T21:59:59.000Z');
    });

    it.each(['PREMIUM', 'LEAGUE'] as const)(
      'rejects %s without an expiry, which would resolve to FREE',
      (tier) => {
        expect(messages({ tier })).toEqual([
          `expiresAt is required for ${tier}: a paid tier without an expiry resolves to FREE`,
        ]);
        expect(messages({ tier, expiresAt: null })).toEqual([
          `expiresAt is required for ${tier}: a paid tier without an expiry resolves to FREE`,
        ]);
      }
    );

    it('rejects an expiry in the past', () => {
      expect(messages({ tier: 'PREMIUM', expiresAt: PAST })).toEqual([
        'expiresAt must be in the future',
      ]);
    });
  });

  describe('FREE tier', () => {
    it('accepts FREE with no expiry and normalizes it to null', () => {
      const result = setSubscriptionSchema.safeParse({ tier: 'FREE' });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ tier: 'FREE', expiresAt: null });
    });

    it('accepts FREE with an explicit null expiry', () => {
      const result = setSubscriptionSchema.safeParse({ tier: 'FREE', expiresAt: null });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ tier: 'FREE', expiresAt: null });
    });

    it('rejects FREE with an expiry', () => {
      expect(messages({ tier: 'FREE', expiresAt: FUTURE })).toEqual([
        'expiresAt must be omitted or null for the FREE tier',
      ]);
    });
  });

  describe('invalid input', () => {
    it.each(['premium', 'GOLD', 'ADMIN', '', null, undefined, 42])('rejects tier %p', (tier) => {
      expect(setSubscriptionSchema.safeParse({ tier, expiresAt: FUTURE }).success).toBe(false);
    });

    it.each(['tomorrow', '2999-01-01', '2999-01-01T00:00:00', '', 4102444800000, true])(
      'rejects expiresAt %p',
      (expiresAt) => {
        expect(setSubscriptionSchema.safeParse({ tier: 'PREMIUM', expiresAt }).success).toBe(false);
      }
    );

    it('rejects a missing body', () => {
      expect(setSubscriptionSchema.safeParse({}).success).toBe(false);
      expect(setSubscriptionSchema.safeParse(undefined).success).toBe(false);
    });

    it('strips extra fields rather than letting them through', () => {
      const result = setSubscriptionSchema.safeParse({
        tier: 'LEAGUE',
        expiresAt: FUTURE,
        role: 'ADMIN',
        deletedAt: null,
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ tier: 'LEAGUE', expiresAt: new Date(FUTURE) });
    });
  });
});
