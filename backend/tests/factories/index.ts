/**
 * Test data factories for generating mock data
 * Provides consistent, typed test data for all entities
 */

import { UserRole, GameStatus, InvitationStatus, GameEventType } from '@prisma/client';

// Counter for generating unique IDs
let idCounter = 0;

/**
 * Generate a unique test ID
 */
export function generateId(prefix = 'test'): string {
  return `${prefix}-${++idCounter}-${Date.now()}`;
}

/**
 * Reset the ID counter (call in beforeEach if needed)
 */
export function resetIdCounter(): void {
  idCounter = 0;
}

// ============================================
// User Factory
// ============================================

export interface UserData {
  id: string;
  workosUserId: string | null;
  email: string;
  name: string;
  role: UserRole;
  emailVerified: boolean;
  profilePictureUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateUserOptions {
  id?: string;
  workosUserId?: string | null;
  email?: string;
  name?: string;
  role?: UserRole;
  emailVerified?: boolean;
  profilePictureUrl?: string | null;
}

export function createUser(options: CreateUserOptions = {}): UserData {
  const id = options.id || generateId('user');
  const now = new Date();

  return {
    id,
    workosUserId: options.workosUserId ?? `workos-${id}`,
    email: options.email || `user-${id}@test.com`,
    name: options.name || `Test User ${id}`,
    role: options.role || 'PLAYER',
    emailVerified: options.emailVerified ?? true,
    profilePictureUrl: options.profilePictureUrl ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

export function createCoach(options: Omit<CreateUserOptions, 'role'> = {}): UserData {
  return createUser({ ...options, role: 'COACH' });
}

export function createPlayer(options: Omit<CreateUserOptions, 'role'> = {}): UserData {
  return createUser({ ...options, role: 'PLAYER' });
}

export function createAdmin(options: Omit<CreateUserOptions, 'role'> = {}): UserData {
  return createUser({ ...options, role: 'ADMIN' });
}

// ============================================
// League Factory
// ============================================

export interface LeagueData {
  id: string;
  name: string;
  season: string;
  year: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateLeagueOptions {
  id?: string;
  name?: string;
  season?: string;
  year?: number;
}

export function createLeague(options: CreateLeagueOptions = {}): LeagueData {
  const id = options.id || generateId('league');
  const now = new Date();

  return {
    id,
    name: options.name || `Test League ${id}`,
    season: options.season || 'Spring',
    year: options.year || new Date().getFullYear(),
    createdAt: now,
    updatedAt: now,
  };
}

// ============================================
// Team Factory
// ============================================

export interface TeamData {
  id: string;
  name: string;
  leagueId: string;
  coachId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateTeamOptions {
  id?: string;
  name?: string;
  leagueId?: string;
  coachId?: string;
}

export function createTeam(options: CreateTeamOptions = {}): TeamData {
  const id = options.id || generateId('team');
  const now = new Date();

  return {
    id,
    name: options.name || `Test Team ${id}`,
    leagueId: options.leagueId || generateId('league'),
    coachId: options.coachId || generateId('coach'),
    createdAt: now,
    updatedAt: now,
  };
}

// ============================================
// Team Member Factory
// ============================================

export interface TeamMemberData {
  id: string;
  teamId: string;
  playerId: string;
  jerseyNumber: number | null;
  position: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateTeamMemberOptions {
  id?: string;
  teamId?: string;
  playerId?: string;
  jerseyNumber?: number | null;
  position?: string | null;
}

export function createTeamMember(options: CreateTeamMemberOptions = {}): TeamMemberData {
  const id = options.id || generateId('member');
  const now = new Date();

  return {
    id,
    teamId: options.teamId || generateId('team'),
    playerId: options.playerId || generateId('player'),
    jerseyNumber: options.jerseyNumber ?? null,
    position: options.position ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

// ============================================
// Game Factory
// ============================================

export interface GameData {
  id: string;
  teamId: string;
  opponent: string;
  date: Date;
  status: GameStatus;
  homeScore: number;
  awayScore: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateGameOptions {
  id?: string;
  teamId?: string;
  opponent?: string;
  date?: Date;
  status?: GameStatus;
  homeScore?: number;
  awayScore?: number;
}

export function createGame(options: CreateGameOptions = {}): GameData {
  const id = options.id || generateId('game');
  const now = new Date();

  return {
    id,
    teamId: options.teamId || generateId('team'),
    opponent: options.opponent || 'Opponent Team',
    date: options.date || new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000), // 1 week from now
    status: options.status || 'SCHEDULED',
    homeScore: options.homeScore ?? 0,
    awayScore: options.awayScore ?? 0,
    createdAt: now,
    updatedAt: now,
  };
}

// ============================================
// Team Invitation Factory
// ============================================

export interface InvitationData {
  id: string;
  teamId: string;
  playerId: string;
  invitedById: string;
  status: InvitationStatus;
  token: string;
  jerseyNumber: number | null;
  position: string | null;
  message: string | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  acceptedAt: Date | null;
  rejectedAt: Date | null;
}

export interface CreateInvitationOptions {
  id?: string;
  teamId?: string;
  playerId?: string;
  invitedById?: string;
  status?: InvitationStatus;
  token?: string;
  jerseyNumber?: number | null;
  position?: string | null;
  message?: string | null;
  expiresAt?: Date;
  acceptedAt?: Date | null;
  rejectedAt?: Date | null;
}

export function createInvitation(options: CreateInvitationOptions = {}): InvitationData {
  const id = options.id || generateId('invitation');
  const now = new Date();
  const expiresAt = options.expiresAt || new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days from now

  return {
    id,
    teamId: options.teamId || generateId('team'),
    playerId: options.playerId || generateId('player'),
    invitedById: options.invitedById || generateId('coach'),
    status: options.status || 'PENDING',
    token: options.token || `token-${id}-${Date.now()}`,
    jerseyNumber: options.jerseyNumber ?? null,
    position: options.position ?? null,
    message: options.message ?? null,
    expiresAt,
    createdAt: now,
    updatedAt: now,
    acceptedAt: options.acceptedAt ?? null,
    rejectedAt: options.rejectedAt ?? null,
  };
}

// ============================================
// Game Event Factory
// ============================================

export interface GameEventData {
  id: string;
  gameId: string;
  playerId: string | null;
  eventType: GameEventType;
  timestamp: Date;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface CreateGameEventOptions {
  id?: string;
  gameId?: string;
  playerId?: string | null;
  eventType?: GameEventType;
  timestamp?: Date;
  metadata?: Record<string, unknown>;
}

export function createGameEvent(options: CreateGameEventOptions = {}): GameEventData {
  const id = options.id || generateId('event');
  const now = new Date();

  return {
    id,
    gameId: options.gameId || generateId('game'),
    playerId: options.playerId ?? null,
    eventType: options.eventType || 'SHOT',
    timestamp: options.timestamp || now,
    metadata: options.metadata || {},
    createdAt: now,
  };
}

// ============================================
// Composite Factory Helpers
// ============================================

/**
 * Create a team with its coach, league, and optional members
 */
export interface FullTeamData {
  team: TeamData;
  coach: UserData;
  league: LeagueData;
  members: Array<{ member: TeamMemberData; player: UserData }>;
}

export interface CreateFullTeamOptions {
  teamName?: string;
  coachOptions?: CreateUserOptions;
  leagueOptions?: CreateLeagueOptions;
  memberCount?: number;
}

export function createFullTeam(options: CreateFullTeamOptions = {}): FullTeamData {
  const coach = createCoach(options.coachOptions);
  const league = createLeague(options.leagueOptions);
  const team = createTeam({
    name: options.teamName,
    coachId: coach.id,
    leagueId: league.id,
  });

  const members: Array<{ member: TeamMemberData; player: UserData }> = [];
  const memberCount = options.memberCount ?? 0;

  for (let i = 0; i < memberCount; i++) {
    const player = createPlayer();
    const member = createTeamMember({
      teamId: team.id,
      playerId: player.id,
      jerseyNumber: i + 1,
    });
    members.push({ member, player });
  }

  return { team, coach, league, members };
}

/**
 * Create a complete invitation scenario
 */
export interface FullInvitationData {
  invitation: InvitationData;
  team: TeamData;
  coach: UserData;
  player: UserData;
  league: LeagueData;
}

export function createFullInvitation(): FullInvitationData {
  const coach = createCoach();
  const player = createPlayer();
  const league = createLeague();
  const team = createTeam({
    coachId: coach.id,
    leagueId: league.id,
  });
  const invitation = createInvitation({
    teamId: team.id,
    playerId: player.id,
    invitedById: coach.id,
  });

  return { invitation, team, coach, player, league };
}
