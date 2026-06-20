/**
 * Unit tests for the issue #40 entitlement middleware:
 *   requireEntitlement(feature) and requireTeamCreateLimit()
 *
 * Verifies the 402 Payment Required contract and the FREE-tier team-cap
 * grandfather behavior using the canonical map in src/services/entitlements.
 */

import { Request, Response, NextFunction } from 'express';
import {
  requireEntitlement,
  requireTeamCreateLimit,
} from '../../src/api/middleware/entitlements';
import { Feature } from '../../src/services/entitlements';
import { mockPrisma } from '../setup';

type TestUser = {
  id: string;
  email: string | null;
  name: string;
  role: string;
  subscriptionTier: 'FREE' | 'PREMIUM' | 'LEAGUE';
  subscriptionExpiresAt: Date | null;
};

function buildUser(overrides: Partial<TestUser> = {}): TestUser {
  return {
    id: 'user-1',
    email: 'coach@test.com',
    name: 'Coach',
    role: 'COACH',
    subscriptionTier: 'FREE',
    subscriptionExpiresAt: null,
    ...overrides,
  };
}

describe('requireEntitlement', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: jest.Mock;

  beforeEach(() => {
    req = {};
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    next = jest.fn();
    jest.clearAllMocks();
  });

  it('calls next with UnauthorizedError when no user is attached', () => {
    requireEntitlement(Feature.STATS_EXPORT)(req as Request, res as Response, next as NextFunction);
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 401 })
    );
  });

  it('blocks a FREE user with 402 and the upgrade-hint payload', () => {
    req.user = buildUser({ subscriptionTier: 'FREE' });
    requireEntitlement(Feature.STATS_EXPORT)(req as Request, res as Response, next as NextFunction);

    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.json).toHaveBeenCalledWith({
      code: 'upgrade_required',
      feature: 'stats_export',
      currentTier: 'FREE',
      requiredTier: 'PREMIUM',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('treats a user without an explicit tier as FREE', () => {
    req.user = { id: 'u', email: null, name: 'x', role: 'COACH' } as unknown as TestUser;
    requireEntitlement(Feature.CALENDAR_SYNC)(req as Request, res as Response, next as NextFunction);

    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ currentTier: 'FREE', feature: 'calendar_sync' })
    );
  });

  it('allows an active PREMIUM user through a premium feature', () => {
    req.user = buildUser({
      subscriptionTier: 'PREMIUM',
      subscriptionExpiresAt: new Date(Date.now() + 86_400_000),
    });
    requireEntitlement(Feature.STATS_EXPORT)(req as Request, res as Response, next as NextFunction);
    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('blocks an EXPIRED premium user (effective tier FREE) with 402', () => {
    req.user = buildUser({
      subscriptionTier: 'PREMIUM',
      subscriptionExpiresAt: new Date('2020-01-01'),
    });
    requireEntitlement(Feature.STATS_EXPORT)(req as Request, res as Response, next as NextFunction);
    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ currentTier: 'FREE' })
    );
  });

  it('blocks a PREMIUM user from a LEAGUE-only feature with requiredTier LEAGUE', () => {
    req.user = buildUser({
      subscriptionTier: 'PREMIUM',
      subscriptionExpiresAt: new Date(Date.now() + 86_400_000),
    });
    requireEntitlement(Feature.TOURNAMENT_BRACKETS)(req as Request, res as Response, next as NextFunction);
    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ feature: 'tournament_brackets', requiredTier: 'LEAGUE' })
    );
  });

  it('allows a LEAGUE user through a league feature', () => {
    req.user = buildUser({
      subscriptionTier: 'LEAGUE',
      subscriptionExpiresAt: new Date(Date.now() + 86_400_000),
    });
    requireEntitlement(Feature.TOURNAMENT_BRACKETS)(req as Request, res as Response, next as NextFunction);
    expect(next).toHaveBeenCalledWith();
  });

  it('bypasses the check for system ADMIN users', () => {
    req.user = buildUser({ role: 'ADMIN', subscriptionTier: 'FREE' });
    requireEntitlement(Feature.STATS_EXPORT)(req as Request, res as Response, next as NextFunction);
    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('requireTeamCreateLimit', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: jest.Mock;

  beforeEach(() => {
    req = {};
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    next = jest.fn();
    jest.clearAllMocks();
  });

  it('calls next with UnauthorizedError when no user is attached', async () => {
    await requireTeamCreateLimit()(req as Request, res as Response, next as NextFunction);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  it('allows a FREE user under the cap', async () => {
    req.user = buildUser({ subscriptionTier: 'FREE' });
    (mockPrisma.teamStaff.count as jest.Mock).mockResolvedValue(2);

    await requireTeamCreateLimit()(req as Request, res as Response, next as NextFunction);

    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('blocks a FREE user AT the cap (3) with 402 upgrade_required', async () => {
    req.user = buildUser({ subscriptionTier: 'FREE' });
    (mockPrisma.teamStaff.count as jest.Mock).mockResolvedValue(3);

    await requireTeamCreateLimit()(req as Request, res as Response, next as NextFunction);

    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.json).toHaveBeenCalledWith({
      code: 'upgrade_required',
      feature: 'unlimited_teams',
      currentTier: 'FREE',
      requiredTier: 'PREMIUM',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('GRANDFATHERS: an over-cap FREE user is blocked from NEW creates only', async () => {
    req.user = buildUser({ subscriptionTier: 'FREE' });
    // Already over the cap (e.g. downgraded). They keep existing teams; the
    // middleware only prevents creating another one.
    (mockPrisma.teamStaff.count as jest.Mock).mockResolvedValue(7);

    await requireTeamCreateLimit()(req as Request, res as Response, next as NextFunction);

    expect(res.status).toHaveBeenCalledWith(402);
    expect(next).not.toHaveBeenCalled();
    // No mutation of existing teams.
    expect(mockPrisma.teamStaff.delete).not.toHaveBeenCalled();
  });

  it('allows PREMIUM users without querying the team count', async () => {
    req.user = buildUser({
      subscriptionTier: 'PREMIUM',
      subscriptionExpiresAt: new Date(Date.now() + 86_400_000),
    });

    await requireTeamCreateLimit()(req as Request, res as Response, next as NextFunction);

    expect(next).toHaveBeenCalledWith();
    expect(mockPrisma.teamStaff.count).not.toHaveBeenCalled();
  });

  it('allows LEAGUE users without querying the team count', async () => {
    req.user = buildUser({
      subscriptionTier: 'LEAGUE',
      subscriptionExpiresAt: new Date(Date.now() + 86_400_000),
    });

    await requireTeamCreateLimit()(req as Request, res as Response, next as NextFunction);

    expect(next).toHaveBeenCalledWith();
    expect(mockPrisma.teamStaff.count).not.toHaveBeenCalled();
  });

  it('bypasses the cap for system ADMIN users', async () => {
    req.user = buildUser({ role: 'ADMIN', subscriptionTier: 'FREE' });

    await requireTeamCreateLimit()(req as Request, res as Response, next as NextFunction);

    expect(next).toHaveBeenCalledWith();
    expect(mockPrisma.teamStaff.count).not.toHaveBeenCalled();
  });
});
