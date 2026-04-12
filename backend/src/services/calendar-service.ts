/**
 * Calendar feed service — generates iCalendar (RFC 5545) feeds for a team's
 * games and manages per-user, per-team opaque feed tokens.
 */

import { randomBytes } from 'crypto';
import { createEvents, EventAttributes, DateArray } from 'ics';
import prisma from '../models';
import { NotFoundError, ForbiddenError, BadRequestError } from '../utils/errors';
import { canAccessTeam } from '../utils/permissions';

// Assume games run ~2 hours. Game model has only a start `date`.
const DEFAULT_GAME_DURATION_HOURS = 2;

/**
 * Public base URL for deep links back to games. Falls back to localhost in dev.
 */
function getPublicAppUrl(): string {
  return process.env.PUBLIC_APP_URL || process.env.API_BASE_URL || 'http://localhost:3000';
}

function dateToDateArray(d: Date): DateArray {
  return [
    d.getUTCFullYear(),
    d.getUTCMonth() + 1,
    d.getUTCDate(),
    d.getUTCHours(),
    d.getUTCMinutes(),
  ];
}

function statusToIcalStatus(status: string): 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED' {
  switch (status) {
    case 'CANCELLED':
      return 'CANCELLED';
    case 'SCHEDULED':
      return 'TENTATIVE';
    case 'IN_PROGRESS':
    case 'FINISHED':
    default:
      return 'CONFIRMED';
  }
}

export class CalendarService {
  /**
   * Generate a new opaque token (base64url-encoded 32 random bytes).
   */
  static generateTokenString(): string {
    return randomBytes(32).toString('base64url');
  }

  /**
   * Subscribe a user to a team's calendar feed. Creates an active token if
   * none exists for the (user, team) pair, otherwise returns the existing one.
   * Caller must have access to the team.
   */
  static async subscribe(teamId: string, userId: string): Promise<{
    token: string;
    feedUrl: string;
    webcalUrl: string;
  }> {
    // Verify team exists
    const team = await prisma.team.findUnique({ where: { id: teamId } });
    if (!team) {
      throw new NotFoundError('Team not found');
    }

    // Must have access to the team
    const hasAccess = await canAccessTeam(userId, teamId);
    if (!hasAccess) {
      throw new ForbiddenError('You do not have access to this team');
    }

    // Reuse an active token if one exists for this (user, team)
    const existing = await prisma.calendarFeedToken.findFirst({
      where: { userId, teamId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    const tokenRow = existing
      ? existing
      : await prisma.calendarFeedToken.create({
          data: {
            userId,
            teamId,
            token: CalendarService.generateTokenString(),
          },
        });

    const base = getPublicAppUrl().replace(/\/$/, '');
    const path = `/api/v1/teams/${teamId}/calendar.ics?token=${encodeURIComponent(
      tokenRow.token
    )}`;
    const httpUrl = `${base}${path}`;
    // webcal:// — strip scheme for calendar-client subscription
    const webcalUrl = httpUrl.replace(/^https?:\/\//, 'webcal://');

    return {
      token: tokenRow.token,
      feedUrl: httpUrl,
      webcalUrl,
    };
  }

  /**
   * Revoke all calendar feed tokens for the given (user, team) pair.
   */
  static async revoke(teamId: string, userId: string): Promise<{ revoked: number }> {
    // Verify team exists — produce a nice 404 instead of a silent no-op.
    const team = await prisma.team.findUnique({ where: { id: teamId } });
    if (!team) {
      throw new NotFoundError('Team not found');
    }

    const result = await prisma.calendarFeedToken.updateMany({
      where: { userId, teamId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    return { revoked: result.count };
  }

  /**
   * Resolve a raw token string to its (userId, teamId), enforcing:
   *   - token exists
   *   - not revoked
   *   - token's teamId matches the URL's teamId
   *   - user still has access to the team
   */
  static async resolveToken(
    teamId: string,
    tokenString: string
  ): Promise<{ userId: string; teamId: string }> {
    if (!tokenString) {
      throw new BadRequestError('Missing calendar token');
    }

    const tokenRow = await prisma.calendarFeedToken.findUnique({
      where: { token: tokenString },
    });

    if (!tokenRow) {
      throw new ForbiddenError('Invalid calendar token');
    }

    if (tokenRow.revokedAt) {
      throw new ForbiddenError('Calendar token has been revoked');
    }

    if (tokenRow.teamId !== teamId) {
      throw new ForbiddenError('Calendar token does not match team');
    }

    // Confirm the user still has access to this team. If not, deny.
    const hasAccess = await canAccessTeam(tokenRow.userId, tokenRow.teamId);
    if (!hasAccess) {
      throw new ForbiddenError('User no longer has access to this team');
    }

    return { userId: tokenRow.userId, teamId: tokenRow.teamId };
  }

  /**
   * Build the iCalendar text for the given team's games.
   * Includes SCHEDULED, IN_PROGRESS, and FINISHED games (and CANCELLED ones
   * marked STATUS:CANCELLED so subscribers see cancellations).
   */
  static async buildFeed(teamId: string): Promise<string> {
    const team = await prisma.team.findUnique({
      where: { id: teamId },
      select: { id: true, name: true },
    });

    if (!team) {
      throw new NotFoundError('Team not found');
    }

    const games = await prisma.game.findMany({
      where: { teamId },
      orderBy: { date: 'asc' },
    });

    const base = getPublicAppUrl().replace(/\/$/, '');

    const events: EventAttributes[] = games.map((game) => {
      const start = new Date(game.date);
      const end = new Date(
        start.getTime() + DEFAULT_GAME_DURATION_HOURS * 60 * 60 * 1000
      );

      const title = `${team.name} vs ${game.opponent}`;
      const descriptionLines = [
        `Status: ${game.status}`,
        game.status === 'FINISHED'
          ? `Final score: ${game.homeScore}-${game.awayScore}`
          : null,
        `View game: ${base}/games/${game.id}`,
      ].filter((l): l is string => !!l);

      return {
        uid: `game-${game.id}@capyhoops.com`,
        start: dateToDateArray(start),
        startInputType: 'utc',
        end: dateToDateArray(end),
        endInputType: 'utc',
        title,
        description: descriptionLines.join('\n'),
        url: `${base}/games/${game.id}`,
        status: statusToIcalStatus(game.status),
        categories: ['Basketball', team.name],
      };
    });

    const { error, value } = createEvents(events, {
      calName: `${team.name} — Basketball Schedule`,
      productId: 'capyhoops/ical',
    });

    if (error) {
      throw error;
    }

    return value || '';
  }
}
