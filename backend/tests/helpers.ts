/**
 * Test helper utilities
 * Common functions and utilities for testing
 */

import { mockPrisma } from './setup';
import { UserData, TeamData, LeagueData, GameData, InvitationData, TeamMemberData, GameEventData } from './factories';

// ============================================
// Mock Setup Helpers
// ============================================

/**
 * Setup mock for finding a user by any criteria
 */
export function mockFindUser(user: UserData | null): void {
  (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(user);
  (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue(user);
}

/**
 * Setup mock for finding multiple users
 */
export function mockFindUsers(users: UserData[]): void {
  (mockPrisma.user.findMany as jest.Mock).mockResolvedValue(users);
  (mockPrisma.user.count as jest.Mock).mockResolvedValue(users.length);
}

/**
 * Setup mock for creating a user
 */
export function mockCreateUser(user: UserData): void {
  (mockPrisma.user.create as jest.Mock).mockResolvedValue(user);
}

/**
 * Setup mock for updating a user
 */
export function mockUpdateUser(user: UserData): void {
  (mockPrisma.user.update as jest.Mock).mockResolvedValue(user);
}

/**
 * Setup mock for finding a team
 */
export function mockFindTeam(team: TeamData | null, includeRelations?: Partial<{
  league: LeagueData;
  coach: Partial<UserData>;
  members: Array<{ player: Partial<UserData>; } & TeamMemberData>;
  games: GameData[];
}>): void {
  const result = team ? {
    ...team,
    ...includeRelations,
  } : null;
  (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(result);
  (mockPrisma.team.findFirst as jest.Mock).mockResolvedValue(result);
}

/**
 * Setup mock for finding multiple teams
 */
export function mockFindTeams(teams: TeamData[]): void {
  (mockPrisma.team.findMany as jest.Mock).mockResolvedValue(teams);
  (mockPrisma.team.count as jest.Mock).mockResolvedValue(teams.length);
}

/**
 * Setup mock for creating a team
 */
export function mockCreateTeam(team: TeamData, includeRelations?: Record<string, unknown>): void {
  (mockPrisma.team.create as jest.Mock).mockResolvedValue({
    ...team,
    ...includeRelations,
  });
}

/**
 * Setup mock for updating a team
 */
export function mockUpdateTeam(team: TeamData, includeRelations?: Record<string, unknown>): void {
  (mockPrisma.team.update as jest.Mock).mockResolvedValue({
    ...team,
    ...includeRelations,
  });
}

/**
 * Setup mock for deleting a team
 */
export function mockDeleteTeam(): void {
  (mockPrisma.team.delete as jest.Mock).mockResolvedValue({});
}

/**
 * Setup mock for finding a league
 */
export function mockFindLeague(league: LeagueData | null, includeRelations?: Record<string, unknown>): void {
  const result = league ? {
    ...league,
    ...includeRelations,
  } : null;
  (mockPrisma.league.findUnique as jest.Mock).mockResolvedValue(result);
  (mockPrisma.league.findFirst as jest.Mock).mockResolvedValue(result);
}

/**
 * Setup mock for finding multiple leagues
 */
export function mockFindLeagues(leagues: LeagueData[]): void {
  (mockPrisma.league.findMany as jest.Mock).mockResolvedValue(leagues);
  (mockPrisma.league.count as jest.Mock).mockResolvedValue(leagues.length);
}

/**
 * Setup mock for creating a league
 */
export function mockCreateLeague(league: LeagueData, includeRelations?: Record<string, unknown>): void {
  (mockPrisma.league.create as jest.Mock).mockResolvedValue({
    ...league,
    ...includeRelations,
  });
}

/**
 * Setup mock for updating a league
 */
export function mockUpdateLeague(league: LeagueData, includeRelations?: Record<string, unknown>): void {
  (mockPrisma.league.update as jest.Mock).mockResolvedValue({
    ...league,
    ...includeRelations,
  });
}

/**
 * Setup mock for deleting a league
 */
export function mockDeleteLeague(): void {
  (mockPrisma.league.delete as jest.Mock).mockResolvedValue({});
}

/**
 * Setup mock for finding a game
 */
export function mockFindGame(game: GameData | null, includeRelations?: Record<string, unknown>): void {
  const result = game ? {
    ...game,
    ...includeRelations,
  } : null;
  (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue(result);
  (mockPrisma.game.findFirst as jest.Mock).mockResolvedValue(result);
}

/**
 * Setup mock for finding multiple games
 */
export function mockFindGames(games: GameData[]): void {
  (mockPrisma.game.findMany as jest.Mock).mockResolvedValue(games);
  (mockPrisma.game.count as jest.Mock).mockResolvedValue(games.length);
}

/**
 * Setup mock for creating a game
 */
export function mockCreateGame(game: GameData, includeRelations?: Record<string, unknown>): void {
  (mockPrisma.game.create as jest.Mock).mockResolvedValue({
    ...game,
    ...includeRelations,
  });
}

/**
 * Setup mock for updating a game
 */
export function mockUpdateGame(game: GameData, includeRelations?: Record<string, unknown>): void {
  (mockPrisma.game.update as jest.Mock).mockResolvedValue({
    ...game,
    ...includeRelations,
  });
}

/**
 * Setup mock for deleting a game
 */
export function mockDeleteGame(): void {
  (mockPrisma.game.delete as jest.Mock).mockResolvedValue({});
}

/**
 * Setup mock for finding an invitation
 */
export function mockFindInvitation(invitation: InvitationData | null, includeRelations?: Record<string, unknown>): void {
  const result = invitation ? {
    ...invitation,
    ...includeRelations,
  } : null;
  (mockPrisma.teamInvitation.findUnique as jest.Mock).mockResolvedValue(result);
  (mockPrisma.teamInvitation.findFirst as jest.Mock).mockResolvedValue(result);
}

/**
 * Setup mock for finding multiple invitations
 */
export function mockFindInvitations(invitations: InvitationData[]): void {
  (mockPrisma.teamInvitation.findMany as jest.Mock).mockResolvedValue(invitations);
  (mockPrisma.teamInvitation.count as jest.Mock).mockResolvedValue(invitations.length);
}

/**
 * Setup mock for creating an invitation
 */
export function mockCreateInvitation(invitation: InvitationData, includeRelations?: Record<string, unknown>): void {
  (mockPrisma.teamInvitation.create as jest.Mock).mockResolvedValue({
    ...invitation,
    ...includeRelations,
  });
}

/**
 * Setup mock for updating an invitation
 */
export function mockUpdateInvitation(invitation: InvitationData, includeRelations?: Record<string, unknown>): void {
  (mockPrisma.teamInvitation.update as jest.Mock).mockResolvedValue({
    ...invitation,
    ...includeRelations,
  });
}

/**
 * Setup mock for team member
 */
export function mockFindTeamMember(member: TeamMemberData | null, includeRelations?: Record<string, unknown>): void {
  const result = member ? {
    ...member,
    ...includeRelations,
  } : null;
  (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(result);
  (mockPrisma.teamMember.findFirst as jest.Mock).mockResolvedValue(result);
}

/**
 * Setup mock for creating a team member
 */
export function mockCreateTeamMember(member: TeamMemberData, includeRelations?: Record<string, unknown>): void {
  (mockPrisma.teamMember.create as jest.Mock).mockResolvedValue({
    ...member,
    ...includeRelations,
  });
}

/**
 * Setup mock for deleting a team member
 */
export function mockDeleteTeamMember(): void {
  (mockPrisma.teamMember.delete as jest.Mock).mockResolvedValue({});
}

/**
 * Setup mock for updating a team member
 */
export function mockUpdateTeamMember(member: TeamMemberData, includeRelations?: Record<string, unknown>): void {
  (mockPrisma.teamMember.update as jest.Mock).mockResolvedValue({
    ...member,
    ...includeRelations,
  });
}

/**
 * Setup mock for finding a game event
 */
export function mockFindGameEvent(event: GameEventData | null, includeRelations?: Record<string, unknown>): void {
  const result = event ? {
    ...event,
    ...includeRelations,
  } : null;
  (mockPrisma.gameEvent.findUnique as jest.Mock).mockResolvedValue(result);
  (mockPrisma.gameEvent.findFirst as jest.Mock).mockResolvedValue(result);
}

/**
 * Setup mock for finding multiple game events
 */
export function mockFindGameEvents(events: GameEventData[]): void {
  (mockPrisma.gameEvent.findMany as jest.Mock).mockResolvedValue(events);
  (mockPrisma.gameEvent.count as jest.Mock).mockResolvedValue(events.length);
}

/**
 * Setup mock for creating a game event
 */
export function mockCreateGameEvent(event: GameEventData, includeRelations?: Record<string, unknown>): void {
  (mockPrisma.gameEvent.create as jest.Mock).mockResolvedValue({
    ...event,
    ...includeRelations,
  });
}

/**
 * Setup mock for deleting a game event
 */
export function mockDeleteGameEvent(): void {
  (mockPrisma.gameEvent.delete as jest.Mock).mockResolvedValue({});
}

// ============================================
// Assertion Helpers
// ============================================

/**
 * Assert that an error was thrown with specific properties
 */
export function expectError(error: unknown, expectedName: string, expectedStatusCode?: number): void {
  expect(error).toBeInstanceOf(Error);
  const err = error as Error & { statusCode?: number };
  expect(err.name).toBe(expectedName);
  if (expectedStatusCode !== undefined) {
    expect(err.statusCode).toBe(expectedStatusCode);
  }
}

/**
 * Assert that a NotFoundError was thrown
 */
export function expectNotFoundError(error: unknown, message?: string): void {
  expect(error).toBeInstanceOf(Error);
  const err = error as Error & { statusCode?: number };
  expect(err.statusCode).toBe(404);
  if (message) {
    expect(err.message).toBe(message);
  }
}

/**
 * Assert that a BadRequestError was thrown
 */
export function expectBadRequestError(error: unknown, message?: string): void {
  expect(error).toBeInstanceOf(Error);
  const err = error as Error & { statusCode?: number };
  expect(err.statusCode).toBe(400);
  if (message) {
    expect(err.message).toBe(message);
  }
}

/**
 * Assert that a ForbiddenError was thrown
 */
export function expectForbiddenError(error: unknown, message?: string): void {
  expect(error).toBeInstanceOf(Error);
  const err = error as Error & { statusCode?: number };
  expect(err.statusCode).toBe(403);
  if (message) {
    expect(err.message).toBe(message);
  }
}

/**
 * Assert that an UnauthorizedError was thrown
 */
export function expectUnauthorizedError(error: unknown, message?: string): void {
  expect(error).toBeInstanceOf(Error);
  const err = error as Error & { statusCode?: number };
  expect(err.statusCode).toBe(401);
  if (message) {
    expect(err.message).toBe(message);
  }
}
