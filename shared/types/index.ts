/**
 * Shared types used across mobile and backend applications
 */

export enum UserRole {
  COACH = 'COACH',
  PARENT = 'PARENT',
  PLAYER = 'PLAYER',
  ADMIN = 'ADMIN',
}

export enum SubscriptionTier {
  FREE = 'FREE',
  PREMIUM = 'PREMIUM',
  LEAGUE = 'LEAGUE',
}

export enum Feature {
  UNLIMITED_TEAMS = 'UNLIMITED_TEAMS',
  FULL_SEASON_HISTORY = 'FULL_SEASON_HISTORY',
  CALENDAR_SYNC = 'CALENDAR_SYNC',
  STATS_EXPORT = 'STATS_EXPORT',
  ADVANCED_STATS = 'ADVANCED_STATS',
  PRACTICE_SCHEDULING = 'PRACTICE_SCHEDULING',
  AD_FREE = 'AD_FREE',
  REGISTRATION_PAYMENTS = 'REGISTRATION_PAYMENTS',
  TOURNAMENT_BRACKETS = 'TOURNAMENT_BRACKETS',
  ORG_MESSAGING = 'ORG_MESSAGING',
  FINANCIAL_REPORTING = 'FINANCIAL_REPORTING',
  MASTER_CALENDAR = 'MASTER_CALENDAR',
}

export interface Entitlements {
  tier: SubscriptionTier;
  features: Record<Feature, boolean>;
  limits: {
    maxTeams: number;
    maxSeasons: number;
  };
  expiresAt: string | null;
}

export enum GameEventType {
  SHOT = 'SHOT',
  REBOUND = 'REBOUND',
  ASSIST = 'ASSIST',
  TURNOVER = 'TURNOVER',
  FOUL = 'FOUL',
  SUBSTITUTION = 'SUBSTITUTION',
  STEAL = 'STEAL',
  BLOCK = 'BLOCK',
  TIMEOUT = 'TIMEOUT',
}

export enum GameStatus {
  SCHEDULED = 'SCHEDULED',
  IN_PROGRESS = 'IN_PROGRESS',
  FINISHED = 'FINISHED',
  CANCELLED = 'CANCELLED',
}

export interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  profilePictureUrl?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface League {
  id: string;
  name: string;
  season: string;
  year: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface Team {
  id: string;
  name: string;
  leagueId: string;
  coachId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface TeamMember {
  id: string;
  teamId: string;
  playerId: string;
  jerseyNumber: number | null;
  position: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Game {
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

export interface GameEvent {
  id: string;
  gameId: string;
  playerId: string | null;
  eventType: GameEventType;
  timestamp: Date;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface PlayerStats {
  playerId: string;
  gameId: string;
  points: number;
  rebounds: number;
  assists: number;
  steals: number;
  blocks: number;
  turnovers: number;
  fouls: number;
  fieldGoalsMade: number;
  fieldGoalsAttempted: number;
  threePointersMade: number;
  threePointersAttempted: number;
  freeThrowsMade: number;
  freeThrowsAttempted: number;
}

export interface TeamStats {
  teamId: string;
  gameId: string;
  points: number;
  rebounds: number;
  assists: number;
  turnovers: number;
  fieldGoalPercentage: number;
  threePointPercentage: number;
  freeThrowPercentage: number;
}

export enum RsvpStatus {
  YES = 'YES',
  NO = 'NO',
  MAYBE = 'MAYBE',
}

export interface GameRsvp {
  id: string;
  gameId: string;
  userId: string;
  status: RsvpStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface Announcement {
  id: string;
  teamId: string;
  authorId: string;
  title: string;
  body: string;
  createdAt: Date;
}

