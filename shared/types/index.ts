/**
 * Shared types used across mobile and backend applications
 */

export enum UserRole {
  COACH = 'COACH',
  PARENT = 'PARENT',
  PLAYER = 'PLAYER',
  ADMIN = 'ADMIN',
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

