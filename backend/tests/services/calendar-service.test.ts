/**
 * Unit tests for CalendarService
 */

import { CalendarService } from '../../src/services/calendar-service';
import { mockPrisma } from '../setup';
import { createTeam, createGame, createUser } from '../factories';
import {
  expectNotFoundError,
  expectForbiddenError,
} from '../helpers';

// Mock canAccessTeam via the permissions module
jest.mock('../../src/utils/permissions', () => ({
  ...jest.requireActual('../../src/utils/permissions'),
  canAccessTeam: jest.fn(),
}));

import { canAccessTeam } from '../../src/utils/permissions';

describe('CalendarService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('subscribe', () => {
    it('creates a new token when none exists', async () => {
      const team = createTeam();
      const user = createUser();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (canAccessTeam as jest.Mock).mockResolvedValue(true);
      (mockPrisma.calendarFeedToken.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.calendarFeedToken.create as jest.Mock).mockImplementation(
        ({ data }: { data: { userId: string; teamId: string; token: string } }) => ({
          id: 'token-id',
          ...data,
          revokedAt: null,
          createdAt: new Date(),
        })
      );

      const result = await CalendarService.subscribe(team.id, user.id);

      expect(mockPrisma.calendarFeedToken.create).toHaveBeenCalledTimes(1);
      expect(result.token).toBeTruthy();
      expect(result.feedUrl).toContain(`/api/v1/teams/${team.id}/calendar.ics`);
      expect(result.feedUrl).toContain(`token=${encodeURIComponent(result.token)}`);
      expect(result.webcalUrl.startsWith('webcal://')).toBe(true);
    });

    it('reuses an existing active token', async () => {
      const team = createTeam();
      const user = createUser();
      const existing = {
        id: 'existing-token',
        userId: user.id,
        teamId: team.id,
        token: 'EXISTING_TOKEN',
        revokedAt: null,
        createdAt: new Date(),
      };

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (canAccessTeam as jest.Mock).mockResolvedValue(true);
      (mockPrisma.calendarFeedToken.findFirst as jest.Mock).mockResolvedValue(existing);

      const result = await CalendarService.subscribe(team.id, user.id);

      expect(mockPrisma.calendarFeedToken.create).not.toHaveBeenCalled();
      expect(result.token).toBe('EXISTING_TOKEN');
    });

    it('throws NotFoundError when team does not exist', async () => {
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await CalendarService.subscribe('missing-team', 'user-id');
        fail('expected NotFoundError');
      } catch (error) {
        expectNotFoundError(error, 'Team not found');
      }
    });

    it('throws ForbiddenError when user cannot access team', async () => {
      const team = createTeam();
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (canAccessTeam as jest.Mock).mockResolvedValue(false);

      try {
        await CalendarService.subscribe(team.id, 'outside-user');
        fail('expected ForbiddenError');
      } catch (error) {
        expectForbiddenError(error);
      }
    });
  });

  describe('revoke', () => {
    it('marks all active tokens as revoked', async () => {
      const team = createTeam();
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.calendarFeedToken.updateMany as jest.Mock).mockResolvedValue({
        count: 3,
      });

      const result = await CalendarService.revoke(team.id, 'user-id');
      expect(result.revoked).toBe(3);
      expect(mockPrisma.calendarFeedToken.updateMany).toHaveBeenCalledWith({
        where: { userId: 'user-id', teamId: team.id, revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it('throws NotFoundError when team does not exist', async () => {
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await CalendarService.revoke('missing', 'user');
        fail('expected NotFoundError');
      } catch (error) {
        expectNotFoundError(error);
      }
    });

    it('resubscribing after revoke issues a NEW token and the old token no longer resolves', async () => {
      const team = createTeam();
      const user = createUser();

      // --- Step 1: initial subscribe → token A ---
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (canAccessTeam as jest.Mock).mockResolvedValue(true);
      (mockPrisma.calendarFeedToken.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.calendarFeedToken.create as jest.Mock).mockImplementation(
        ({ data }: { data: { userId: string; teamId: string; token: string } }) => ({
          id: 'token-a-id',
          ...data,
          revokedAt: null,
          createdAt: new Date(),
        })
      );

      const firstSub = await CalendarService.subscribe(team.id, user.id);
      const tokenA = firstSub.token;
      expect(tokenA).toBeTruthy();

      // --- Step 2: revoke ---
      (mockPrisma.calendarFeedToken.updateMany as jest.Mock).mockResolvedValue({
        count: 1,
      });
      const revokeResult = await CalendarService.revoke(team.id, user.id);
      expect(revokeResult.revoked).toBe(1);

      // --- Step 3: subscribe again → findFirst now returns null (no active
      // tokens remain after revoke), so a NEW token B is created ---
      (mockPrisma.calendarFeedToken.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.calendarFeedToken.create as jest.Mock).mockImplementation(
        ({ data }: { data: { userId: string; teamId: string; token: string } }) => ({
          id: 'token-b-id',
          ...data,
          revokedAt: null,
          createdAt: new Date(),
        })
      );

      const secondSub = await CalendarService.subscribe(team.id, user.id);
      const tokenB = secondSub.token;

      expect(tokenB).toBeTruthy();
      expect(tokenB).not.toEqual(tokenA);
      // create() was called again (not reused)
      expect(mockPrisma.calendarFeedToken.create).toHaveBeenCalledTimes(2);

      // --- Step 4: resolving the old revoked token A must fail ---
      (mockPrisma.calendarFeedToken.findUnique as jest.Mock).mockResolvedValue({
        id: 'token-a-id',
        userId: user.id,
        teamId: team.id,
        token: tokenA,
        revokedAt: new Date(),
        createdAt: new Date(),
      });
      await expect(
        CalendarService.resolveToken(team.id, tokenA)
      ).rejects.toThrow(/revoked/);
    });
  });

  describe('resolveToken', () => {
    it('resolves a valid token', async () => {
      const team = createTeam();
      const tokenRow = {
        id: 'id',
        userId: 'user-1',
        teamId: team.id,
        token: 'abc',
        revokedAt: null,
        createdAt: new Date(),
      };
      (mockPrisma.calendarFeedToken.findUnique as jest.Mock).mockResolvedValue(tokenRow);
      (canAccessTeam as jest.Mock).mockResolvedValue(true);

      const res = await CalendarService.resolveToken(team.id, 'abc');
      expect(res).toEqual({ userId: 'user-1', teamId: team.id });
    });

    it('rejects missing token with BadRequest', async () => {
      await expect(CalendarService.resolveToken('t', '')).rejects.toThrow(/Missing/);
    });

    it('rejects unknown token with Forbidden', async () => {
      (mockPrisma.calendarFeedToken.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(CalendarService.resolveToken('t', 'nope')).rejects.toThrow(/Invalid/);
    });

    it('rejects revoked token', async () => {
      (mockPrisma.calendarFeedToken.findUnique as jest.Mock).mockResolvedValue({
        id: 'id',
        userId: 'u',
        teamId: 't',
        token: 'abc',
        revokedAt: new Date(),
        createdAt: new Date(),
      });
      await expect(CalendarService.resolveToken('t', 'abc')).rejects.toThrow(/revoked/);
    });

    it('rejects token whose teamId does not match the URL', async () => {
      (mockPrisma.calendarFeedToken.findUnique as jest.Mock).mockResolvedValue({
        id: 'id',
        userId: 'u',
        teamId: 'team-A',
        token: 'abc',
        revokedAt: null,
        createdAt: new Date(),
      });
      await expect(
        CalendarService.resolveToken('team-B', 'abc')
      ).rejects.toThrow(/does not match/);
    });

    it('rejects when user no longer has team access', async () => {
      (mockPrisma.calendarFeedToken.findUnique as jest.Mock).mockResolvedValue({
        id: 'id',
        userId: 'u',
        teamId: 't',
        token: 'abc',
        revokedAt: null,
        createdAt: new Date(),
      });
      (canAccessTeam as jest.Mock).mockResolvedValue(false);
      await expect(
        CalendarService.resolveToken('t', 'abc')
      ).rejects.toThrow(/no longer has access/);
    });
  });

  describe('buildFeed', () => {
    it('returns a valid iCalendar document with events for all game statuses', async () => {
      const team = createTeam({ name: 'Lakers' });
      const games = [
        createGame({ teamId: team.id, status: 'SCHEDULED', opponent: 'Celtics' }),
        createGame({ teamId: team.id, status: 'IN_PROGRESS', opponent: 'Bulls' }),
        createGame({
          teamId: team.id,
          status: 'FINISHED',
          opponent: 'Heat',
          homeScore: 95,
          awayScore: 90,
        }),
        createGame({ teamId: team.id, status: 'CANCELLED', opponent: 'Nets' }),
      ];

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        id: team.id,
        name: team.name,
      });
      (mockPrisma.game.findMany as jest.Mock).mockResolvedValue(games);

      const ics = await CalendarService.buildFeed(team.id);

      expect(ics).toContain('BEGIN:VCALENDAR');
      expect(ics).toContain('END:VCALENDAR');
      // One VEVENT per game
      const eventMatches = ics.match(/BEGIN:VEVENT/g) || [];
      expect(eventMatches.length).toBe(4);
      expect(ics).toContain('Lakers vs Celtics');
      expect(ics).toContain('STATUS:CANCELLED');
      expect(ics).toContain('STATUS:TENTATIVE'); // SCHEDULED
      expect(ics).toContain('Final score: 95-90');

      // RFC 5545 requires DTSTAMP on every VEVENT. The `ics` library emits
      // this automatically — this assertion guards against regressions.
      const dtstampMatches = ics.match(/DTSTAMP:/g) || [];
      expect(dtstampMatches.length).toBe(eventMatches.length);
    });

    it('returns an empty-but-valid calendar when team has no games', async () => {
      const team = createTeam({ name: 'Nomads' });
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        id: team.id,
        name: team.name,
      });
      (mockPrisma.game.findMany as jest.Mock).mockResolvedValue([]);

      const ics = await CalendarService.buildFeed(team.id);
      expect(ics).toContain('BEGIN:VCALENDAR');
      expect(ics).toContain('END:VCALENDAR');
      expect(ics).not.toContain('BEGIN:VEVENT');
    });

    it('throws NotFoundError if team does not exist', async () => {
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(CalendarService.buildFeed('missing')).rejects.toThrow(/Team not found/);
    });
  });

  describe('generateTokenString', () => {
    it('returns distinct opaque strings of reasonable length', () => {
      const a = CalendarService.generateTokenString();
      const b = CalendarService.generateTokenString();
      expect(a).not.toEqual(b);
      expect(a.length).toBeGreaterThanOrEqual(32);
      // base64url: no + / = characters
      expect(a).not.toMatch(/[+/=]/);
    });
  });
});
