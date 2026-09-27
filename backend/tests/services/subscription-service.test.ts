/**
 * Unit tests for SubscriptionService (#445): the system-ADMIN path that sets
 * an account's subscription tier while there is no purchase flow.
 */

import { mockPrisma } from '../setup';

jest.mock('../../src/utils/redis', () => ({
  cacheGetJson: jest.fn(),
  cacheSetJson: jest.fn(),
  cacheDelete: jest.fn(),
}));

import {
  SubscriptionService,
  USER_SUBSCRIPTION_SELECT,
} from '../../src/services/subscription-service';
import { cacheDelete } from '../../src/utils/redis';

const mockCacheDelete = cacheDelete as jest.Mock;

const ADMIN = { id: 'a1b2c3d4-e5f6-4890-a234-567890abcdef', role: 'ADMIN' };
const TARGET_ID = 'b2c3d4e5-f6a7-4901-a345-67890abcdef0';
const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

function mockTarget(
  before: { subscriptionTier: string; subscriptionExpiresAt: Date | null; deletedAt: Date | null } | null
): void {
  (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(before);
}

function mockWrite(after: { subscriptionTier: string; subscriptionExpiresAt: Date | null }): void {
  (mockPrisma.user.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
  (mockPrisma.user.findUniqueOrThrow as jest.Mock).mockResolvedValue({
    id: TARGET_ID,
    name: 'Casey Coach',
    email: 'casey@example.com',
    role: 'COACH',
    ...after,
  });
}

describe('SubscriptionService.setSubscription', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('puts a FREE user on PREMIUM until the expiry and reports the effective tier', async () => {
    mockTarget({ subscriptionTier: 'FREE', subscriptionExpiresAt: null, deletedAt: null });
    mockWrite({ subscriptionTier: 'PREMIUM', subscriptionExpiresAt: FUTURE });

    const result = await SubscriptionService.setSubscription(
      TARGET_ID,
      { tier: 'PREMIUM', expiresAt: FUTURE },
      ADMIN
    );

    expect(result.effectiveTier).toBe('PREMIUM');
    expect(result.user).toEqual({
      id: TARGET_ID,
      name: 'Casey Coach',
      email: 'casey@example.com',
      role: 'COACH',
      subscriptionTier: 'PREMIUM',
      subscriptionExpiresAt: FUTURE,
    });
    expect(mockPrisma.user.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { id: TARGET_ID },
      select: USER_SUBSCRIPTION_SELECT,
    });
  });

  it('guards the write with deletedAt IS NULL (#444 invariant)', async () => {
    mockTarget({ subscriptionTier: 'FREE', subscriptionExpiresAt: null, deletedAt: null });
    mockWrite({ subscriptionTier: 'LEAGUE', subscriptionExpiresAt: FUTURE });

    await SubscriptionService.setSubscription(TARGET_ID, { tier: 'LEAGUE', expiresAt: FUTURE }, ADMIN);

    expect(mockPrisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: TARGET_ID, deletedAt: null },
      data: { subscriptionTier: 'LEAGUE', subscriptionExpiresAt: FUTURE },
    });
  });

  it('returns a comped account to FREE and clears the expiry', async () => {
    mockTarget({ subscriptionTier: 'PREMIUM', subscriptionExpiresAt: FUTURE, deletedAt: null });
    mockWrite({ subscriptionTier: 'FREE', subscriptionExpiresAt: null });

    const result = await SubscriptionService.setSubscription(
      TARGET_ID,
      { tier: 'FREE', expiresAt: null },
      ADMIN
    );

    expect(result.effectiveTier).toBe('FREE');
    expect(mockPrisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: TARGET_ID, deletedAt: null },
      data: { subscriptionTier: 'FREE', subscriptionExpiresAt: null },
    });
  });

  it("invalidates the target user's cached usage, not the admin's", async () => {
    mockTarget({ subscriptionTier: 'FREE', subscriptionExpiresAt: null, deletedAt: null });
    mockWrite({ subscriptionTier: 'PREMIUM', subscriptionExpiresAt: FUTURE });

    await SubscriptionService.setSubscription(TARGET_ID, { tier: 'PREMIUM', expiresAt: FUTURE }, ADMIN);

    expect(mockCacheDelete).toHaveBeenCalledTimes(1);
    expect(mockCacheDelete).toHaveBeenCalledWith(`usage:counts:${TARGET_ID}`);
  });

  it.each(['COACH', 'PLAYER', 'PARENT'])('refuses a %s actor before touching the database', async (role) => {
    await expect(
      SubscriptionService.setSubscription(
        TARGET_ID,
        { tier: 'PREMIUM', expiresAt: FUTURE },
        { id: ADMIN.id, role }
      )
    ).rejects.toMatchObject({
      statusCode: 403,
      message: 'Only system admins can change a subscription',
    });

    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a user changing their own tier unless they are an ADMIN', async () => {
    await expect(
      SubscriptionService.setSubscription(
        TARGET_ID,
        { tier: 'LEAGUE', expiresAt: FUTURE },
        { id: TARGET_ID, role: 'COACH' }
      )
    ).rejects.toMatchObject({
      statusCode: 403,
      message: 'Only system admins can change a subscription',
    });

    expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
  });

  it('throws NotFoundError for an unknown user and writes nothing', async () => {
    mockTarget(null);

    await expect(
      SubscriptionService.setSubscription(TARGET_ID, { tier: 'PREMIUM', expiresAt: FUTURE }, ADMIN)
    ).rejects.toMatchObject({
      statusCode: 404,
      message: 'User not found',
    });

    expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
    expect(mockCacheDelete).not.toHaveBeenCalled();
  });

  it('refuses a deleted account (tombstone) and writes nothing', async () => {
    mockTarget({
      subscriptionTier: 'FREE',
      subscriptionExpiresAt: null,
      deletedAt: new Date('2026-09-01'),
    });

    await expect(
      SubscriptionService.setSubscription(TARGET_ID, { tier: 'PREMIUM', expiresAt: FUTURE }, ADMIN)
    ).rejects.toMatchObject({
      statusCode: 400,
      message: 'Cannot change the subscription of a deleted account',
    });

    expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
    expect(mockCacheDelete).not.toHaveBeenCalled();
  });

  it('refuses when the account is deleted between the read and the write', async () => {
    mockTarget({ subscriptionTier: 'FREE', subscriptionExpiresAt: null, deletedAt: null });
    // The guarded updateMany matches no row: the deletion committed first.
    (mockPrisma.user.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

    await expect(
      SubscriptionService.setSubscription(TARGET_ID, { tier: 'PREMIUM', expiresAt: FUTURE }, ADMIN)
    ).rejects.toMatchObject({
      statusCode: 400,
      message: 'Cannot change the subscription of a deleted account',
    });

    expect(mockPrisma.user.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(mockCacheDelete).not.toHaveBeenCalled();
  });
});
